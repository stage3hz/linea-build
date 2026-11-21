import UIKit

/// The stack of screens: no system bar on top (every screen draws its own header), and a swipe from the left
/// edge always goes back.
final class NavigationController: UINavigationController, UIGestureRecognizerDelegate {
    override func viewDidLoad() {
        super.viewDidLoad()
        setNavigationBarHidden(true, animated: false)
        view.backgroundColor = Theme.bg
        interactivePopGestureRecognizer?.delegate = self
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool { viewControllers.count > 1 }
}
