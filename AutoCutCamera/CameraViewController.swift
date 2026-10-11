import UIKit
import WebKit

/// Màn hình duy nhất: WKWebView chạy giao diện www (nạp qua địa chỉ riêng autocut-cam://app/…).
/// - Cho trang dùng camera / micro (WebRTC gửi hình thẳng tới máy tính trong mạng Wi-Fi).
/// - window.AutoCutNative: tên máy, link ghép đôi — giống bản Android.
/// - acHttp: gọi tới máy AutoCut (http://192.168.x.x) bằng URLSession, vì WKWebView chặn trang trong app gọi thẳng.
final class CameraViewController: UIViewController, WKUIDelegate, WKScriptMessageHandlerWithReply {
    static let scheme = "autocut-cam"

    private var web: WKWebView!
    private var loaded = false
    /// Link ghép đôi chưa giao cho trang (app vừa mở, trang chưa tải xong)
    private var pendingLink: String?

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: Self.scheme)
        let ucc = cfg.userContentController
        ucc.addScriptMessageHandler(self, contentWorld: .page, name: "acHttp")
        ucc.addUserScript(WKUserScript(source: bridgeScript(), injectionTime: .atDocumentStart, forMainFrameOnly: true))

        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.isScrollEnabled = false
        web.scrollView.bounces = false
        // Chẩn đoán bằng Safari trên Mac (Develop → iPhone)
        if #available(iOS 16.4, *) { web.isInspectable = true }
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        web.load(URLRequest(url: URL(string: "\(Self.scheme)://app/index.html")!))
        loaded = true
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // MARK: - link ghép đôi

    func receive(link url: URL) {
        let s = url.absoluteString
        guard loaded else { pendingLink = s; return }
        web.evaluateJavaScript("window.__acLink = \(jsString(s)); window.onPairLink && window.onPairLink();")
    }

    private func bridgeScript() -> String {
        let link = pendingLink ?? ""
        pendingLink = nil
        return """
        window.__acLink = \(jsString(link));
        window.AutoCutNative = {
          platform: "ios",
          deviceName: function () { return \(jsString(Self.deviceName())); },
          discover: function () { return "[]"; },
          takeLink: function () { var l = window.__acLink || ""; window.__acLink = ""; return l; }
        };
        """
    }

    private func jsString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        let arr = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(arr.dropFirst().dropLast())
    }

    /// "iPhone 16 Pro Max"… (iOS 16+ không cho đọc tên máy người dùng đặt → đọc mã máy)
    static func deviceName() -> String {
        var info = utsname()
        uname(&info)
        let id = withUnsafePointer(to: &info.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(cString: $0) } }
        let names: [String: String] = [
            "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,5": "iPhone 16e",
            "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
            "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
            "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max", "iPhone14,5": "iPhone 13", "iPhone14,4": "iPhone 13 mini",
        ]
        return names[id] ?? (id.hasPrefix("iPhone") ? "iPhone" : UIDevice.current.model)
    }

    // MARK: - camera / micro: luôn cho phép (iOS vẫn hỏi người dùng lần đầu theo Info.plist)

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.protocol == Self.scheme ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Huỷ", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    // MARK: - gọi tới máy AutoCut trong mạng (chỉ http(s), chỉ địa chỉ mạng nội bộ)

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let d = message.body as? [String: Any], let s = d["url"] as? String, let url = URL(string: s),
              let scheme = url.scheme, ["http", "https"].contains(scheme), let host = url.host, Self.isLocal(host) else {
            return replyHandler(nil, "Địa chỉ không hợp lệ")
        }
        let timeout = (d["timeout"] as? Double ?? 8000) / 1000
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: max(1, timeout))
        req.httpMethod = d["method"] as? String ?? "GET"
        if let body = d["body"] as? String {
            req.httpBody = Data(body.utf8)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        URLSession.shared.dataTask(with: req) { data, resp, err in
            DispatchQueue.main.async {
                if let err = err { return replyHandler(nil, err.localizedDescription) }
                let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                replyHandler(["status": status, "body": String(data: data ?? Data(), encoding: .utf8) ?? ""], nil)
            }
        }.resume()
    }

    /// Mạng nhà / văn phòng: 10.x, 172.16–31.x, 192.168.x, 169.254.x, .local
    static func isLocal(_ host: String) -> Bool {
        if host.hasSuffix(".local") || host == "localhost" { return true }
        let p = host.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4 else { return false }
        return p[0] == 10 || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 192 && p[1] == 168) || (p[0] == 169 && p[1] == 254)
    }
}

/// Phục vụ file trong thư mục www của app tại autocut-cam://app/…
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root = Bundle.main.resourceURL!.appendingPathComponent("www", isDirectory: true).standardizedFileURL

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return task.didFailWithError(URLError(.badURL)) }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Length": "0"])!)
            task.didFinish()
            return
        }
        let headers = [
            "Content-Type": Self.mime(file.pathExtension),
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache",
            "Access-Control-Allow-Origin": "*",
        ]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    static func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "wasm": return "application/wasm"
        case "json": return "application/json"
        case "png": return "image/png"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }
}
