import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import AgentSwitchKit

/// Attachments (app-v0 §5): multipart upload, task files, downloads, the image preparation that strips location
/// metadata, and the text a voice may read.
final class AttachmentTests: XCTestCase {
    private let lan = APIEndpoint(host: "192.168.1.5", port: 4713, kind: .lan)

    func testMultipartBody() throws {
        let body = Multipart.body([UploadFile(name: "shot \"1\".png", type: "image/png", data: Data([1, 2])),
                                   UploadFile(name: "a\r\nb.txt", type: "", data: Data("x".utf8))], boundary: "B")
        let text = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("--B\r\nContent-Disposition: form-data; name=\"files\"; filename=\"shot %221%22.png\"\r\nContent-Type: image/png\r\n\r\n\u{1}\u{2}\r\n"))
        XCTAssertTrue(text.contains("filename=\"ab.txt\"\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n"), "no header injection, a default type")
        XCTAssertTrue(text.hasSuffix("--B--\r\n"))
    }

    func testUploadIsOneMultipartPostAndCreateCarriesTheIds() async throws {
        let transport = FakeTransport { req, _ in
            if req.url?.path == "/uploads" {
                return (json(["files": [["id": "u1", "name": "a.png", "size": 2, "type": "image/png"]]]), httpResponse(req.url))
            }
            return (try Fixture.data("task.json"), httpResponse(req.url, status: 201))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let staged = try await api.upload([UploadFile(name: "a.png", type: "image/png", data: Data([1, 2]))])
        XCTAssertEqual(staged.map(\.id), ["u1"])
        _ = try await api.createTask(NewTaskRequest(task: "看图", attachments: staged.map(\.id)))

        let upload = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(upload.httpMethod, "POST")
        XCTAssertEqual(upload.timeoutInterval, AgentSwitchAPI.uploadTimeout)
        let type = try XCTUnwrap(upload.value(forHTTPHeaderField: "Content-Type"))
        XCTAssertTrue(type.hasPrefix("multipart/form-data; boundary="))
        let body = try XCTUnwrap(transport.requests.last?.httpBody.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual(body["attachments"] as? [String], ["u1"])
    }

    func testUploadIsNeverResent() async {
        let transport = FakeTransport(handler: { _, _ in throw APIError.transport("timed out") })
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        do { _ = try await api.upload([UploadFile(name: "a", type: "", data: Data([1]))]); XCTFail() } catch {}
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testTaskFilesAndDownloadPaths() async throws {
        let transport = FakeTransport { req, _ in
            if req.url?.path == "/tasks/t1/files" {
                return (json(["root": "cwd", "files": [["path": "in/a.png", "size": 2, "mtime": 1], ["path": "out/报告 1.pdf", "size": 9, "mtime": 2]]]), httpResponse(req.url))
            }
            return (Data([7, 8, 9]), httpResponse(req.url, contentType: "application/pdf"))
        }
        let api = AgentSwitchAPI(endpoints: FixedEndpoint(lan), transport: transport, token: "tok")
        let files = try await api.taskFiles("t1")
        XCTAssertEqual(files.map(\.path), ["in/a.png", "out/报告 1.pdf"])
        XCTAssertEqual(files.map(\.isDeliverable), [false, true])
        XCTAssertEqual(files[1].name, "报告 1.pdf")
        let data = try await api.download(taskId: "t1", path: "out/报告 1.pdf")
        XCTAssertEqual(data, Data([7, 8, 9]))
        XCTAssertEqual(transport.requests.last?.url?.absoluteString, "https://192.168.1.5:4713/tasks/t1/files/out/%E6%8A%A5%E5%91%8A%201.pdf")
    }

    // MARK: - images

    private func image(width: Int, height: Int, type: UTType, gps: Bool) throws -> Data {
        let ctx = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        ctx.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let out = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil))
        let props: [CFString: Any] = gps ? [kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 31.2, kCGImagePropertyGPSLongitude: 121.5]] : [:]
        CGImageDestinationAddImage(dest, try XCTUnwrap(ctx.makeImage()), props as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return out as Data
    }

    private func properties(_ data: Data) -> [CFString: Any] {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return [:] }
        return CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] ?? [:]
    }

    func testPhotosShrinkToJPEGWithoutLocation() throws {
        let photo = try image(width: 4000, height: 3000, type: .jpeg, gps: true)
        XCTAssertNotNil(properties(photo)[kCGImagePropertyGPSDictionary])
        let prepared = try XCTUnwrap(ImagePrep.prepare(UploadFile(name: "IMG_1.HEIC", type: "image/heic", data: photo)))
        XCTAssertEqual(prepared.name, "IMG_1.jpg")
        XCTAssertEqual(prepared.type, "image/jpeg")
        let props = properties(prepared.data)
        XCTAssertNil(props[kCGImagePropertyGPSDictionary], "no location leaves the phone")
        XCTAssertEqual(props[kCGImagePropertyPixelWidth] as? Int, ImagePrep.maxPixel)
        XCTAssertEqual(props[kCGImagePropertyPixelHeight] as? Int, 1536)
    }

    func testScreenshotsStayPNGAndSmallOnesKeepTheirSize() throws {
        let shot = try image(width: 800, height: 600, type: .png, gps: false)
        let prepared = try XCTUnwrap(ImagePrep.prepare(UploadFile(name: "粘贴的图片.png", type: "image/png", data: shot)))
        XCTAssertEqual(prepared.type, "image/png")
        XCTAssertEqual(prepared.name, "粘贴的图片.png")
        XCTAssertEqual(properties(prepared.data)[kCGImagePropertyPixelWidth] as? Int, 800)
        let pdf = UploadFile(name: "a.pdf", type: "application/pdf", data: Data("%PDF".utf8))
        XCTAssertEqual(ImagePrep.prepare(pdf), pdf, "not an image: as is")
        XCTAssertNil(ImagePrep.prepare(UploadFile(name: "x.jpg", type: "image/jpeg", data: Data([0, 1, 2]))), "an unreadable image is refused")
    }

    // MARK: - speech

    func testSpeakableText() {
        let token = "enc:v1:" + String(repeating: "A", count: 40)
        XCTAssertEqual(Speech.speakable("**结论**：详见 https://x.com/a/status/2103 ，@chenju_ai 说 \(token) 可用。\n- 第二点 `code`"),
                       "结论：详见，chenju ai 说 可用。第二点 code")
        XCTAssertEqual(Speech.speakable("编号 2103074361611817341 太长"), "编号 太长", "long id runs are dropped")
        XCTAssertEqual(Speech.speakable("  "), "")
        XCTAssertEqual(Speech.speakable("密码是\(token)，已填入"), "密码是，已填入", "a token right after Chinese is dropped too")
        XCTAssertEqual(Speech.speakable("发到 alice@example.com，并 @ 了 @chenju_ai"), "发到 alice@example.com，并 @ 了 chenju ai")
        XCTAssertEqual(Speech.speakable("会话 sk_live_9fQ2xLmP4rT8wZ1c 已失效，version2 正常"), "会话 已失效，version2 正常")
        XCTAssertEqual(Speech.speakable("见 [removed: not a secret-gate token] 这里"), "见 这里")
    }

    func testGIFsAndVectorImagesPassUntouched() {
        let gif = UploadFile(name: "a.gif", type: "image/gif", data: Data("GIF89a".utf8))
        XCTAssertEqual(ImagePrep.prepare(gif), gif, "a GIF would lose its animation")
        let svg = UploadFile(name: "a.svg", type: "image/svg+xml", data: Data("<svg/>".utf8))
        XCTAssertEqual(ImagePrep.prepare(svg), svg)
    }

    func testCachePathsStayInsideTheTaskFolder() {
        XCTAssertEqual(TaskFile.cacheSegments(taskId: "t1", path: "out/sub/报告.pdf"), ["t1", "out", "sub", "报告.pdf"])
        XCTAssertEqual(TaskFile.cacheSegments(taskId: "t1", path: "../../etc/./passwd"), ["t1", "etc", "passwd"])
        XCTAssertEqual(TaskFile.cacheSegments(taskId: "../x", path: ""), ["x", "file"])
    }

    func testPreviewableAndSourceOnlyFiles() {
        XCTAssertTrue(TaskFile(path: "out/a.pdf", size: 1, isDeliverable: true).opensInPreview)
        XCTAssertFalse(TaskFile(path: "out/page.html", size: 1, isDeliverable: true).opensInPreview, "HTML/SVG could load remote resources")
        XCTAssertFalse(TaskFile(path: "out/logo.SVG", size: 1, isDeliverable: true).opensInPreview)
    }
}
