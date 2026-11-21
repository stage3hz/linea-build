import UIKit

#if targetEnvironment(simulator)
/// The simulator check of the chat's look, with the sample chat (`-demo 1 -chat 1`), no account:
///   -chatlook header      the glass header: «назад» with 3 unread, the name in platinum with 🌿, «в сети»,
///                         «Позвонить» and the teal avatar on the right; the teal light on the left; the open look
///                         with the thin teal line by the other side's words
///   -chatlook peek        the same, then the large avatar card with «Открыть профиль»
///   -chatlook bubbles     bubbles (as with «Пузыри сообщений» on), own messages in the theme's bubble colour
///   -chatlook wallpaper   the «Аврора» gradient wallpaper (bubbles come with it), the header's edge in its colour
///   -chatlook swipe       a message of the other side held half-way in a swipe to the left, the round arrow shown
///   -chatlook reply       the swipe done: the bar «Ответ Алиса Воронцова» above the field
///   -chatlook arrive      a new message of the other side slides in a moment after the chat opens
///   -chatlook picker      «Обои чатов» opened over the chat
///   -chatlook preview     the preview of «Аврора» with the sample messages, «Отмена» and «Установить»
///   -chatlook bubblecolor «Цвет своих сообщений»
///   -chatlookline offline|connecting   the status line says «ожидание сети…» / «соединение…»
/// Nothing of it is kept: the next launch shows the chat as the settings say.
enum ChatLookDemo {
    static func run(_ screen: ChatViewController) {
        guard let ask = UserDefaults.standard.string(forKey: "chatlook") else { return }
        switch ask {
        case "bubbles":
            ChatBubbleLook.demoBubbles = true
        case "wallpaper":
            Wallpapers.demo = .preset("aurora")
        default:
            break
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak screen] in
            guard let screen else { return }
            switch ask {
            case "peek":
                screen.look.showPeek()
            case "swipe":
                screen.look.demoSwipe(done: false)
            case "reply":
                screen.look.demoSwipe(done: true)
            case "arrive":
                screen.look.demoArrive()
            case "picker":
                WallpaperPickerController.present(over: screen, chatId: "00000000-0000-0000-0000-000000000000")
            case "preview":
                let preview = WallpaperPreviewController(draft: .preset("aurora"), forChat: true)
                screen.present(preview, animated: true)
            case "bubblecolor":
                screen.navigationController?.pushViewController(BubbleColorViewController(), animated: true)
            default:
                break
            }
        }
    }
}

extension ChatLookScreen {
    /// A message of the other side moved 70 points to the left (or the swipe finished: the answer bar).
    func demoSwipe(done: Bool) {
        guard let list = listForDemo else { return }
        list.demoSwipe(done: done)
    }

    /// A new message of the other side, added after the chat's rows.
    func demoArrive() {
        guard let list = listForDemo else { return }
        list.demoArrive()
    }
}

extension MsgListView {
    func demoSwipe(done: Bool) {
        guard let found = demoTheirs() else { return }
        if done {
            onSwipeReply(["key": found.key])
            return
        }
        swipeDemo(view: found.view)
    }
}
#endif
