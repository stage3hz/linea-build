import UIKit

/// What the settings ask of the signed-in account: its own profile, and leaving it.
///
/// Leaving does what the previous app did (`logout` and `credentialsChanged` of `mobile/App.tsx`) and nothing
/// more: the session's token and the kept copy of the profile are removed from this device. The encrypted
/// storage and the keys of the conversations stay where they are.
extension Messenger {
    /// Posted on the main queue when the account's own profile changed (a new name, colour, @username…).
    static let ownProfileChanged = Notification.Name("invizent.own-profile-changed")

    /// The account's profile as the server last gave it.
    var ownProfile: [String: Any] {
        if let kept = Account.cachedUser, kept["id"] as? String == userId { return kept }
        return user
    }

    /// Keeps a fresh copy of the account's profile (the server's `user`) and tells the screens.
    func keepOwnProfile(_ fresh: [String: Any]) {
        guard fresh["id"] as? String == userId else { return }
        Account.cachedUser = fresh
        NotificationCenter.default.post(name: Messenger.ownProfileChanged, object: nil)
    }

    /// A server operation whose answer is an object; `done` is called on the main queue.
    func accountCall(_ name: String, _ args: [Any], done: @escaping (Result<[String: Any], ServerError>) -> Void) {
        server.op(name, args) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let body): done(.success(body as? [String: Any] ?? [:]))
                case .failure(let error): done(.failure(error))
                }
            }
        }
    }

    /// Asks the server for the profile again (it may have been changed on another device).
    func refreshOwnProfile() {
        accountCall("me", []) { [weak self] result in
            guard let self, case .success(let body) = result, let fresh = body["user"] as? [String: Any] else { return }
            self.keepOwnProfile(fresh)
        }
    }

    /// The headers a person's picture is asked with, if the list of chats has not set them yet.
    func prepareSettingsAvatars() {
        guard ChatAvatarStore.shared.headers.isEmpty,
              let made = Core.prepare(method: "GET", path: "/files/x", jsonBody: false, token: server.token, proof: server.currentProof) else { return }
        ChatAvatarStore.shared.headers = Dictionary(made.headers, uniquingKeysWith: { first, _ in first })
    }

    /// Removes the session from this device: the token, the kept profile, the headers pictures were asked with.
    /// False when the token could not be removed (then nothing else is touched), unless `anyway`.
    private func forgetSession(anyway: Bool) -> Bool {
        Account.token = nil
        let gone = Account.token == nil
        guard gone || anyway else { return false }
        Account.cachedUser = nil
        server.token = nil
        ChatAvatarStore.shared.headers = [:]
        KeptMedia.wipe() // Video: films kept for watching without the network go with the account (as the reference's cache)
        return gone
    }

    /// «Выйти из аккаунта»: the server ends this session, then it is forgotten here. `done` (main queue) gets
    /// the words for the sign-in screen (empty when all went well), or why leaving was not finished.
    func signOut(done: @escaping (Result<String, ServerError>) -> Void) {
        server.op("logout", []) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                var notice = ""
                if case .failure(let error) = result {
                    switch error {
                    case .refused(_, let status, _, _):
                        // 401: the session is already over on the server — exactly what was wanted.
                        if status != 401 { notice = "Выход выполнен на этом устройстве. Сервер не подтвердил отзыв удалённой сессии." }
                    case .network, .timeout:
                        notice = "Выход выполнен на этом устройстве. Сервер недоступен — удалённую сессию отозвать не удалось."
                    }
                }
                guard self.forgetSession(anyway: false) else {
                    done(.failure(.network("Не удалось удалить сохранённую сессию с устройства. Выход не завершён. Попробуй ещё раз.")))
                    return
                }
                done(.success(notice))
            }
        }
    }

    /// The server has already ended this session (a secret was changed, the session was ended from the list,
    /// the account was deleted): it is forgotten here. Returns the words for the sign-in screen.
    func sessionEndedHere(_ words: String) -> String {
        if forgetSession(anyway: true) { return words }
        return words + " Сохранённую копию отозванной сессии не удалось удалить с устройства; сервер больше её не принимает."
    }
}

extension ServerError {
    /// The HTTP status of a refusal; 0 when the server did not answer.
    var refusalStatus: Int {
        if case .refused(_, let status, _, _) = self { return status }
        return 0
    }
}
