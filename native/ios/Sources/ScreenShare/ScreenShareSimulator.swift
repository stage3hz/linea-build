#if targetEnvironment(simulator)
import UIKit

/// The simulator's samples of screen sharing (no account, no server, no media; the pictures are drawn here):
///   -screendemo panel      the sample server's voice channel «Общий», this phone inside: the panel «Демонстрация экрана»
///                          with «720p · 60 FPS» and «1080p · 60 FPS», the warning, and Марина Ким's screen
///                          («Марина Ким · 1080p · 60 FPS») with a drawn desktop
///   -screendemo viewer     the same screen on the whole phone: «Марина Ким · 1080p · 60 FPS», «Закрыть», «Повернуть»
///   -screendemo starting   the buttons dimmed while the system's sheet is up, «Отменить запуск»
///   -screendemo sharing    this phone shares: the red «Остановить демонстрацию», «Твой экран» with its drawn picture
///   -screendemo error      the notice «Профиль подписи не разрешает App Groups для демонстрации экрана.»
///   -screendemo room       inside the room «Походники»: the strip «Лариса · показывает экран» under the room's bar
///   -screendemo bar        the voice channel's bar over the chats while sharing: the red stop button left of the microphone
extension SceneDelegate {
    /// True when `-screendemo` decided the start.
    func simulatorScreenShare() -> Bool {
        guard let demo = UserDefaults.standard.string(forKey: "screendemo") else { return false }
        let root = RootViewController()
        let stack = NavigationController(rootViewController: root)
        window?.rootViewController = stack
        root.loadViewIfNeeded()
        if demo == "room" {
            root.show("channels")
            Rooms.shared.showDemo(me: RoomsDemo.me, rooms: RoomsDemo.rooms(), ring: nil)
            RoomsDemo.walkIn()
            ScreenShare.shared.showDemo(screens: [(peer: "peer-1", userId: "demo-r1", quality: .p1080)], sharing: nil, starting: false, error: "")
            stack.pushViewController(RoomViewController(roomId: "demo-room-1"), animated: false)
            RoomOverlay.shared.refresh()
            return true
        }
        let peers = [RoomVoicePeer(peer: "peer-2", userId: "demo-u2", muted: true, connected: true),
                     RoomVoicePeer(peer: "peer-3", userId: "demo-u3", muted: false, connected: true)]
        RoomVoice.shared.showDemo(roomId: "demo-server-voice", name: "Общий", peers: peers, muted: false, speaking: [], community: (id: "demo-server", name: "Клан «Север»"))
        let marina: [(peer: String, userId: String, quality: ScreenQuality)] = [(peer: "peer-3", userId: "demo-u3", quality: .p1080)]
        switch demo {
        case "starting": ScreenShare.shared.showDemo(screens: marina, sharing: nil, starting: true, error: "")
        case "sharing", "bar": ScreenShare.shared.showDemo(screens: demo == "bar" ? [] : marina, sharing: .p1080, starting: false, error: "")
        case "error": ScreenShare.shared.showDemo(screens: [], sharing: nil, starting: false, error: "Профиль подписи не разрешает App Groups для демонстрации экрана.")
        default: ScreenShare.shared.showDemo(screens: marina, sharing: nil, starting: false, error: "")
        }
        if demo == "bar" {
            root.show("chats")
            RoomOverlay.shared.refresh()
            return true
        }
        root.show("channels")
        let screen = CommunityViewController(messenger: nil, communityId: "demo-server", known: ChannelsDemo.summaries().first { (item: CommunitySummary) -> Bool in item.id == "demo-server" })
        stack.pushViewController(screen, animated: false)
        if demo == "viewer" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                let viewer = ScreenViewerController(peer: "peer-3", names: { (userId: String) -> String? in userId == "demo-u3" ? "Марина Ким" : nil })
                stack.present(viewer, animated: false)
            }
        } else {
            // The panel is at the bottom of the community's list.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                guard let table = ScreenShareDemo.firstTable(in: screen.view) else { return }
                let bottom = max(0, table.contentSize.height - table.bounds.height + table.adjustedContentInset.bottom)
                table.setContentOffset(CGPoint(x: 0, y: bottom), animated: false)
            }
        }
        return true
    }
}

/// The drawn sample frames: a computer's desktop with an editor and a chart, or a phone's home screen. Calm colours.
enum ScreenShareDemo {
    static func firstTable(in view: UIView) -> UITableView? {
        if let table = view as? UITableView { return table }
        for child in view.subviews { if let found = firstTable(in: child) { return found } }
        return nil
    }

    static func frame(desktop: Bool) -> UIImage {
        let size = desktop ? CGSize(width: 1280, height: 720) : CGSize(width: 720, height: 405)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { (context: UIGraphicsImageRendererContext) -> Void in
            let g = context.cgContext
            let colors = [UIColor(hex: 0x1C2430).cgColor, UIColor(hex: 0x2A3442).cgColor] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) {
                g.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: size.width, y: size.height), options: [])
            }
            if !desktop {
                // A phone's chats, shown wide: rows of round pictures and lines.
                let tints: [UInt32] = [0x4F8FD9, 0x4FB86A, 0xD9A24F, 0x8A7FD0, 0x5FA8A8]
                for row in 0..<5 {
                    let y = 40 + CGFloat(row) * 70
                    UIColor(hex: tints[row]).setFill()
                    UIBezierPath(ovalIn: CGRect(x: 40, y: y, width: 44, height: 44)).fill()
                    UIColor(white: 1, alpha: 0.75).setFill()
                    UIBezierPath(roundedRect: CGRect(x: 100, y: y + 6, width: 220, height: 12), cornerRadius: 6).fill()
                    UIColor(white: 1, alpha: 0.35).setFill()
                    UIBezierPath(roundedRect: CGRect(x: 100, y: y + 26, width: 380, height: 10), cornerRadius: 5).fill()
                }
                return
            }
            // The editor window.
            let editor = CGRect(x: 70, y: 60, width: 720, height: 540)
            UIColor(hex: 0x121820).setFill()
            UIBezierPath(roundedRect: editor, cornerRadius: 14).fill()
            UIColor(hex: 0x232C38).setFill()
            UIBezierPath(roundedRect: CGRect(x: editor.minX, y: editor.minY, width: editor.width, height: 40), byRoundingCorners: [.topLeft, .topRight], cornerRadii: CGSize(width: 14, height: 14)).fill()
            let lights: [UInt32] = [0xE06C5F, 0xE0B65F, 0x6FBF73]
            for (index, hex) in lights.enumerated() {
                UIColor(hex: hex).setFill()
                UIBezierPath(ovalIn: CGRect(x: editor.minX + 18 + CGFloat(index) * 22, y: editor.minY + 13, width: 14, height: 14)).fill()
            }
            let palette: [UInt32] = [0x7FA7D9, 0xC9D1D9, 0x8CC48F, 0xD9B07F, 0xC9D1D9, 0x9A8FD0]
            let indents: [Int] = [0, 1, 2, 2, 1, 2, 3, 3, 2, 1, 0, 1, 2, 2, 1, 0, 1, 1]
            for line in 0..<18 {
                let y = editor.minY + 64 + CGFloat(line) * 27
                let indent = CGFloat(indents[line]) * 28
                UIColor(white: 1, alpha: 0.18).setFill()
                UIBezierPath(roundedRect: CGRect(x: editor.minX + 18, y: y, width: 24, height: 10), cornerRadius: 3).fill()
                var x = editor.minX + 60 + indent
                for word in 0..<(2 + line % 4) {
                    let width = CGFloat(40 + ((line * 37 + word * 53) % 120))
                    UIColor(hex: palette[(line + word) % palette.count]).withAlphaComponent(0.85).setFill()
                    UIBezierPath(roundedRect: CGRect(x: x, y: y, width: width, height: 10), cornerRadius: 3).fill()
                    x += width + 12
                }
            }
            // The chart window.
            let chart = CGRect(x: 830, y: 120, width: 380, height: 300)
            UIColor(hex: 0x18202A).setFill()
            UIBezierPath(roundedRect: chart, cornerRadius: 14).fill()
            let bars: [CGFloat] = [0.35, 0.55, 0.42, 0.7, 0.62, 0.85, 0.74]
            for (index, value) in bars.enumerated() {
                let height = (chart.height - 80) * value
                UIColor(hex: 0x5FA8A8).withAlphaComponent(0.55 + 0.06 * CGFloat(index)).setFill()
                UIBezierPath(roundedRect: CGRect(x: chart.minX + 30 + CGFloat(index) * 48, y: chart.maxY - 30 - height, width: 30, height: height), cornerRadius: 5).fill()
            }
            // The task bar.
            UIColor(white: 0, alpha: 0.35).setFill()
            g.fill(CGRect(x: 0, y: size.height - 48, width: size.width, height: 48))
            for index in 0..<6 {
                UIColor(white: 1, alpha: index == 1 ? 0.8 : 0.4).setFill()
                UIBezierPath(roundedRect: CGRect(x: size.width / 2 - 165 + CGFloat(index) * 56, y: size.height - 38, width: 30, height: 28), cornerRadius: 7).fill()
            }
        }
    }
}
#endif
