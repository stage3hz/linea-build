#if targetEnvironment(simulator)
import UIKit

/// What the simulator check asks of the shell, with `-demo 1` (no account):
///   -shelldemo mini        a sample track chosen, «Люди» open: the mini-player above the bar outside «Музыка»
///   -shelldemo chatstrip   a sample track and the sample chat: the player strip under the chat's header
///   -shelldemo swipe       the sample chat held 45 % off by the swipe back: the list moved aside and dimmed under it
///   -shelldemo long        two screens pushed, the swipe held past a third: «Отпусти — в чаты»
///   -shelldemo home        «Люди» open: the round mark of the edge swipe to «Чаты»
///   -updatedemo required | optional    the update screen / window (Shell/UpdateGate.swift)
enum ShellDemo {
    static func run(_ root: RootViewController) {
        guard let demo = UserDefaults.standard.string(forKey: "shelldemo"), !demo.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            guard let stack = root.navigationController as? NavigationController else { return }
            let tracks = MusicDemo.tracks
            switch demo {
            case "mini":
                MusicPlayer.shared.simulatorShow(tracks, current: tracks[1], position: 74, favorites: [])
                root.show("people")
            case "chatstrip":
                MusicPlayer.shared.simulatorShow(tracks, current: tracks[1], position: 74, favorites: [])
                stack.pushViewController(ChatViewController(name: "Алиса Воронцова"), animated: false)
            case "swipe":
                stack.pushViewController(ChatViewController(name: "Алиса Воронцова"), animated: false)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { stack.holdSwipe(at: 0.45) }
            case "long":
                stack.pushViewController(ChatViewController(name: "Алиса Воронцова"), animated: false)
                stack.pushViewController(ChatViewController(name: "Марк Соловьёв"), animated: false)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    stack.holdSwipe(at: 0.5)
                    stack.showSwipeMarks(long: true)
                }
            case "home":
                root.show("people")
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { stack.showSwipeMarks(long: false) }
            default:
                break
            }
        }
    }
}
#endif
