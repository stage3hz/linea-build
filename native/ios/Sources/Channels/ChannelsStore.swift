import UIKit

extension Live {
    /// Posted on the main queue for every event of the live line about communities (its `type` begins with
    /// «community») and when the line is ready again; `userInfo["event"]` is the event as it came.
    static let communityEvent = Notification.Name("invizent.community-event")
}

/// The person's communities and what is unread in them: the list of «Каналы», the marks on its rows and on a
/// community's channels, the number on the section's row in the bar. The server is the source of truth
/// (summaries, channel lists, «community.read» events); new messages bump the numbers at once.
/// Reference: mobile/src/communities/unread.ts and the socket listener of CommunitiesScreen.tsx. Main queue only.
final class ChannelsStore: NSObject {
    static let shared = ChannelsStore()
    /// Posted when the list or a counter changed.
    static let changed = Notification.Name("invizent.channels")

    struct Counts {
        var unread = 0
        var mentions = 0
        var muted = false
        var communityId = ""
    }

    /// nil until the list has been read once.
    private(set) var list: [CommunitySummary]?
    /// Why the list could not be read; empty when it could.
    private(set) var failure = ""
    private var communities: [String: Counts] = [:]
    private var channels: [String: Counts] = [:]
    /// The channel on screen right now: its new messages are read as they come.
    private var viewing = ""
    private weak var messenger: Messenger?
    private var observing = false

    private override init() { super.init() }

    /// Begins to follow the account (a new sign-in forgets what the previous account had).
    func start(_ messenger: Messenger?) {
        if let messenger, let current = self.messenger, current === messenger { return }
        self.messenger = messenger
        ChannelImages.shared.server = messenger?.server
        ChannelOutbox.shared.start(messenger)
        list = nil
        failure = ""
        communities = [:]
        channels = [:]
        viewing = ""
        if !observing {
            observing = true
            NotificationCenter.default.addObserver(self, selector: #selector(event(_:)), name: Live.communityEvent, object: nil)
        }
        post()
        reload()
    }

    private func post() {
        NotificationCenter.default.post(name: ChannelsStore.changed, object: nil)
    }

    /// Reads the list of communities again. A failed reading keeps the list that is shown.
    func reload() {
        guard let messenger else { return }
        messenger.server.op("communities", []) { [weak self, weak messenger] result in
            DispatchQueue.main.async {
                guard let self, let messenger, self.messenger === messenger else { return }
                switch result {
                case .success(let body):
                    let found = CommunitySummary.list((body as? [String: Any])?["communities"])
                    self.list = found
                    self.failure = ""
                    var counts: [String: Counts] = [:]
                    for item in found { counts[item.id] = Counts(unread: item.unread, mentions: item.mentions, muted: item.muted, communityId: item.id) }
                    self.communities = counts
                    self.channels = self.channels.filter { counts[$0.value.communityId] != nil }
                case .failure(let error):
                    self.failure = error.words
                }
                self.post()
            }
        }
    }

    // MARK: What the screens tell

    /// A community was read from the server (opened, changed, joined).
    func put(_ summary: CommunitySummary) {
        if !summary.isMember { return remove(summary.id) }
        communities[summary.id] = Counts(unread: summary.unread, mentions: summary.mentions, muted: summary.muted, communityId: summary.id)
        if var known = list {
            if let index = known.firstIndex(where: { $0.id == summary.id }) { known[index] = summary } else { known.insert(summary, at: 0) }
            list = known
        }
        post()
    }

    func remove(_ id: String) {
        communities[id] = nil
        channels = channels.filter { $0.value.communityId != id }
        list = list?.filter { $0.id != id }
        post()
    }

    /// The channels of an opened community, each with its own counters.
    func setChannels(_ communityId: String, _ found: [CommunityChannel]) {
        channels = channels.filter { $0.value.communityId != communityId }
        for channel in found where channel.isText {
            channels[channel.id] = Counts(unread: channel.unread, mentions: channel.mentions, muted: false, communityId: communityId)
        }
        post()
    }

    func setViewing(_ channelId: String) {
        viewing = channelId
    }

    /// The server's answer to «read up to here».
    func read(communityId: String, channelId: String, unread: Int, mentions: Int, community: CommunitySummary?) {
        if var counts = channels[channelId] {
            counts.unread = unread
            counts.mentions = mentions
            channels[channelId] = counts
        }
        if let community { communities[community.id] = Counts(unread: community.unread, mentions: community.mentions, muted: community.muted, communityId: community.id) }
        post()
    }

    // MARK: What the screens ask

    func counts(community id: String) -> Counts { return communities[id] ?? Counts() }
    func counts(channel id: String) -> Counts { return channels[id] ?? Counts() }

    /// The number on the section's row: a muted community counts only its @mentions.
    var badge: Int {
        var total = 0
        for counts in communities.values { total += counts.muted ? counts.mentions : counts.unread }
        return total
    }

    // MARK: The live line

    @objc private func event(_ note: Notification) {
        guard let messenger, let data = note.userInfo?["event"] as? [String: Any], let type = data["type"] as? String else { return }
        switch type {
        case "ready":
            reload()
        case "community":
            if let summary = CommunitySummary(data["community"]) { put(summary) }
        case "community.removed":
            if let id = data["communityId"] as? String { remove(id) }
        case "community.read":
            guard let channelId = data["channelId"] as? String else { return }
            let community = CommunitySummary(data["community"])
            read(communityId: data["communityId"] as? String ?? "", channelId: channelId, unread: (data["unread"] as? NSNumber)?.intValue ?? 0,
                 mentions: (data["mentions"] as? NSNumber)?.intValue ?? 0, community: community)
        case "community.message":
            guard let communityId = data["communityId"] as? String, let message = data["message"] as? [String: Any] else { return }
            if var known = list, let index = known.firstIndex(where: { $0.id == communityId }) {
                known[index].lastText = message["text"] as? String ?? ""
                list = known
            }
            let edited = data["edited"] as? Bool ?? false
            let channelId = message["channelId"] as? String ?? ""
            if !edited, message["senderId"] as? String != messenger.userId, channelId != viewing, var community = communities[communityId] {
                let mention = (data["mentions"] as? [String] ?? []).contains(messenger.userId) ? 1 : 0
                community.unread += 1
                community.mentions += mention
                communities[communityId] = community
                if var channel = channels[channelId] {
                    channel.unread += 1
                    channel.mentions += mention
                    channels[channelId] = channel
                }
            }
            post()
        default:
            break
        }
    }
}
