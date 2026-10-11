import UIKit

/// AutoCut Camera (iPhone) — biến iPhone thành camera cho AutoCut Studio.
/// Vỏ Swift tối giản: giao diện + camera + WebRTC + quét mã QR dùng chung với bản Android (thư mục www).
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let vc = CameraViewController()
        // Mở app bằng link ghép đôi (quét QR bằng Camera của iPhone → trang AutoCut → "Mở app")
        if let url = launchOptions?[.url] as? URL { vc.receive(link: url) }
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = vc
        w.makeKeyAndVisible()
        window = w
        // Giữ màn hình sáng khi đang làm camera
        application.isIdleTimerDisabled = true
        return true
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        guard url.scheme == "autocut" else { return false }
        (window?.rootViewController as? CameraViewController)?.receive(link: url)
        return true
    }
}
