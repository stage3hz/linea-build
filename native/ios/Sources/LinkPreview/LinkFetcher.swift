import ImageIO
import UIKit

/// Fetches the page of a link the person has just written, to make its card.
///
/// Privacy first — this is the only code of the app that talks to a site the person names:
/// - It runs on the SENDER's phone only, and only for a link typed into the composer while «Предпросмотр ссылок»
///   is on. Our server is not involved and never learns the link; the recipient's phone never fetches anything.
/// - `https` only, the default port only, public host names only (the shared core's `fetchable`); every address
///   the name resolves to is checked before the request and the address actually reached after it — loopback,
///   private and link-local networks are never read from.
/// - A session of its own that keeps nothing: no cookies, no cache, no saved passwords, no client certificates.
///   The request says nothing about the app, the account or the device beyond what any phone browser says.
/// - At most three redirects, each checked the same way; six seconds; the first 256 KiB of the page; a picture
///   of at most 2 MiB, which is scaled down, encoded again and cleaned by the core before it goes anywhere.
/// - A page is only read as text by the core's parser. Nothing of it is run, shown in a web view or followed.
/// Nothing is written to logs.
final class LinkFetcher {
    static let shared = LinkFetcher()

    private let work = DispatchQueue(label: "invizent.link-fetch", qos: .utility)
    /// Cards made in this run of the app, by the link as written: typing on does not fetch the page again.
    /// In memory only. A page that gave no card is not remembered: it may have been the network.
    private var made: [String: [String: Any]] = [:]
    private var order: [String] = []

    /// One piece of work that can be given up.
    final class Ticket {
        fileprivate var cancelled = false
        fileprivate var job: LinkDownload?
        /// Main queue.
        func cancel() {
            cancelled = true
            job?.cancel()
        }
    }

    /// Makes the card for a link (the core's `candidate` of the composer's text). `done` comes on the main queue,
    /// with the card for `encrypt` or nil. Call on the main queue.
    @discardableResult
    func card(for url: String, done: @escaping ([String: Any]?) -> Void) -> Ticket {
        let ticket = Ticket()
        guard LinkSettings.on, LinkCore.fetchable(url) else {
            DispatchQueue.main.async { done(nil) }
            return ticket
        }
        if let known = made[url] {
            DispatchQueue.main.async { if !ticket.cancelled { done(known) } }
            return ticket
        }
        let limits = LinkCore.limits
        let page = LinkDownload(url: url, kind: .page, cap: limits.htmlBytes, limits: limits, queue: work)
        ticket.job = page
        page.start { [weak self] (result: LinkDownload.Loaded?) -> Void in
            // On the fetcher's queue.
            guard let self, let result, let parsed = LinkCore.parse(html: result.body, contentType: result.contentType, pageUrl: result.finalUrl) else {
                self?.finish(url, nil, ticket, done)
                return
            }
            guard let pictureUrl = parsed.imageUrl else {
                self.finish(url, LinkCore.wire(url: url, site: parsed.site, title: parsed.title, description: parsed.description, jpeg: nil), ticket, done)
                return
            }
            let picture = LinkDownload(url: pictureUrl, kind: .picture, cap: limits.imageDownloadBytes, limits: limits, queue: self.work)
            DispatchQueue.main.async {
                if ticket.cancelled { return }
                ticket.job = picture
                picture.start { [weak self] (loaded: LinkDownload.Loaded?) -> Void in
                    guard let self else { return }
                    let jpeg = loaded.flatMap { LinkFetcher.small($0.body, side: limits.imageSide, bytes: limits.imageBytes) }
                    self.finish(url, LinkCore.wire(url: url, site: parsed.site, title: parsed.title, description: parsed.description, jpeg: jpeg), ticket, done)
                }
            }
        }
        return ticket
    }

    private func finish(_ url: String, _ card: [String: Any]?, _ ticket: Ticket, _ done: @escaping ([String: Any]?) -> Void) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            ticket.job = nil
            if ticket.cancelled { return }
            if let card, self.made[url] == nil {
                self.order.append(url)
                if self.order.count > 24 { self.made.removeValue(forKey: self.order.removeFirst()) }
                self.made[url] = card
            }
            done(card)
        }
    }

    /// Forgets the cards made so far (the setting was switched off, the account was left).
    func forget() {
        made.removeAll()
        order.removeAll()
    }

    // MARK: The picture

    /// A downloaded picture as the small JPEG a card carries: at most `side` points a side and `bytes` bytes.
    /// The file is never decoded at its full size, and one that claims an absurd size is not decoded at all.
    static func small(_ data: Data, side: Int, bytes: Int) -> Data? {
        let options: [CFString: Any] = [kCGImageSourceShouldCache: false]
        guard let source = CGImageSourceCreateWithData(data as CFData, options as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0, height > 0, width <= 12000, height <= 12000, width * height <= 40_000_000 else { return nil }
        // A sliver is not a picture of anything.
        if width < 40 || height < 40 { return nil }
        for edge in [side, side * 3 / 4, side / 2] {
            let thumb: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                          kCGImageSourceThumbnailMaxPixelSize: edge, kCGImageSourceShouldCacheImmediately: true]
            guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumb as CFDictionary) else { return nil }
            let size = CGSize(width: image.width, height: image.height)
            if size.width < 1 || size.height < 1 || Int(size.width) > side || Int(size.height) > side { return nil }
            // Drawn anew on white (a JPEG has no transparency), one pixel per point: nothing of the original
            // file but its pixels goes on.
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            // Plain sRGB: the colour profile does not travel with the cleaned picture.
            format.preferredRange = .standard
            let flat = UIGraphicsImageRenderer(size: size, format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                UIImage(cgImage: image).draw(in: CGRect(origin: .zero, size: size))
            }
            for quality in [0.82, 0.7, 0.58, 0.46, 0.34] {
                if let jpeg = flat.jpegData(compressionQuality: CGFloat(quality)), jpeg.count <= bytes - 512 { return jpeg }
            }
        }
        return nil
    }
}

/// One download: the start of a page, or a picture. Lives for one request and its redirects.
final class LinkDownload: NSObject, URLSessionDataDelegate {
    enum Kind { case page, picture }

    struct Loaded {
        let body: Data
        let contentType: String?
        /// The address the answer finally came from, after redirects.
        let finalUrl: String
    }

    private let url: String
    private let kind: Kind
    private let cap: Int
    private let limits: LinkCore.Limits
    private let queue: DispatchQueue
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var body = Data()
    private var response: HTTPURLResponse?
    private var redirects = 0
    private var refused = false
    private var full = false
    private var done: ((Loaded?) -> Void)?

    init(url: String, kind: Kind, cap: Int, limits: LinkCore.Limits, queue: DispatchQueue) {
        self.url = url
        self.kind = kind
        self.cap = cap
        self.limits = limits
        self.queue = queue
        super.init()
    }

    /// `done` comes once, on the fetcher's queue.
    func start(done: @escaping (Loaded?) -> Void) {
        queue.async { [self] in
            self.done = done
            guard let address = URL(string: url), LinkDownload.allowed(address) else {
                end(nil)
                return
            }
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.httpCookieAcceptPolicy = .never
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            configuration.urlCredentialStorage = nil
            // No system proxy: through one the address really reached could not be checked.
            configuration.connectionProxyDictionary = [:]
            configuration.timeoutIntervalForRequest = limits.timeout
            configuration.timeoutIntervalForResource = limits.timeout
            configuration.waitsForConnectivity = false
            configuration.httpMaximumConnectionsPerHost = 1
            configuration.httpAdditionalHeaders = [
                "User-Agent": LinkFetcherAgent.words,
                "Accept": kind == .page ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" : "image/jpeg,image/png,image/webp,image/*;q=0.8",
                "Accept-Language": "ru,en;q=0.8",
            ]
            let callbacks = OperationQueue()
            callbacks.underlyingQueue = queue
            callbacks.maxConcurrentOperationCount = 1
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: callbacks)
            self.session = session
            var request = URLRequest(url: address)
            request.httpMethod = "GET"
            request.httpShouldHandleCookies = false
            let task = session.dataTask(with: request)
            self.task = task
            task.resume()
        }
    }

    /// Any queue.
    func cancel() {
        queue.async { [self] in
            done = nil
            task?.cancel()
            session?.invalidateAndCancel()
            session = nil
        }
    }

    private func end(_ result: Loaded?) {
        let finished = done
        done = nil
        session?.invalidateAndCancel()
        session = nil
        task = nil
        finished?(result)
    }

    /// Whether an address may be contacted: the core's rules for the address itself, and no address its host
    /// name resolves to on a private, loopback or link-local network.
    private static func allowed(_ address: URL) -> Bool {
        guard LinkCore.fetchable(address.absoluteString), let host = address.host, !host.isEmpty else { return false }
        return LinkDownload.resolvesPublic(host)
    }

    /// Every address of a host name, asked of the system's resolver (the same one the request will use).
    private static func resolvesPublic(_ host: String) -> Bool {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC
        hints.ai_socktype = SOCK_STREAM
        var list: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &list) == 0, let first = list else { return false }
        defer { freeaddrinfo(first) }
        var found = 0
        var entry: UnsafeMutablePointer<addrinfo>? = first
        while let item = entry {
            entry = item.pointee.ai_next
            guard let socket = item.pointee.ai_addr else { continue }
            var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(socket, item.pointee.ai_addrlen, &name, socklen_t(name.count), nil, 0, NI_NUMERICHOST) != 0 { return false }
            if LinkCore.privateAddress(String(cString: name)) { return false }
            found += 1
        }
        return found > 0
    }

    // MARK: URLSession

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        redirects += 1
        guard redirects <= limits.redirects, let next = request.url, LinkDownload.allowed(next) else {
            // Not followed: the answer is the redirect itself, which is no page.
            refused = true
            completionHandler(nil)
            return
        }
        var followed = URLRequest(url: next)
        followed.httpMethod = "GET"
        followed.httpShouldHandleCookies = false
        completionHandler(followed)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        // The server's certificate is checked by the system, as for any request. Nothing else is answered: no
        // password and no client certificate is ever offered to a site.
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            completionHandler(.performDefaultHandling, nil)
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard !refused, let answer = response as? HTTPURLResponse, (200..<300).contains(answer.statusCode), answer.url?.scheme?.lowercased() == "https" else {
            refused = true
            completionHandler(.cancel)
            return
        }
        let type = (answer.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        let fits: Bool
        switch kind {
        case .page: fits = type.isEmpty || type.hasPrefix("text/html") || type.hasPrefix("application/xhtml+xml")
        case .picture: fits = type.hasPrefix("image/") && !type.hasPrefix("image/svg")
        }
        // A picture that says it is larger than the limit is not started.
        let tooLong = kind == .picture && answer.expectedContentLength > Int64(cap)
        guard fits, !tooLong else {
            refused = true
            completionHandler(.cancel)
            return
        }
        self.response = answer
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if refused || full { return }
        let room = cap - body.count
        if data.count <= room {
            body.append(data)
            return
        }
        switch kind {
        case .page:
            // The head of a page is in its first kilobytes: the rest is not needed and not read.
            body.append(data.prefix(max(0, room)))
            full = true
        case .picture:
            refused = true
        }
        dataTask.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        // The address that was really reached (a name can resolve differently a moment later): an answer from a
        // private network is thrown away unread.
        for transaction in metrics.transactionMetrics {
            if let remote = transaction.remoteAddress, LinkCore.privateAddress(remote) { refused = true }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard !refused, let response, let reached = response.url?.absoluteString, !body.isEmpty, error == nil || full else {
            end(nil)
            return
        }
        end(Loaded(body: body, contentType: response.value(forHTTPHeaderField: "Content-Type"), finalUrl: reached))
    }
}

/// The words of the `User-Agent` header: what any phone browser says — no app name, no version of ours, no
/// account, no device model.
enum LinkFetcherAgent {
    static let words = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
}
