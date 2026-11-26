import Foundation

/// Files that may hold a password or a key (docs/files-v0.md §7.3): shown and previewed as any other, asked about once
/// before an agent gets one. The service's table (daemon src/files/browse.ts `sensitiveReason`), the same rules here for
/// this Mac's own paths — a file dragged in from Finder is asked about without asking the service; another node's files
/// come with the service's word (`FileDetails.sensitive`). By where a file really is and its name only: nothing is read.
public enum FilesSensitive {
    private static let homeFolders: [(String, String)] = [(".ssh", "ssh"), (".gnupg", "gnupg"), ("Library/Keychains", "keychain")]
    private static let homeFiles: [(String, String)] = [
        (".aws/credentials", "cloud"), (".netrc", "login"), (".git-credentials", "login"), (".npmrc", "login"), (".pypirc", "login"),
        (".docker/config.json", "login"), (".kube/config", "cloud"), (".config/gh/hosts.yml", "login"),
        (".codex/auth.json", "login"), (".claude/.credentials.json", "login"), (".local/share/opencode/auth.json", "login"), (".pi/agent/auth.json", "login"), (".grok/auth.json", "login"),
    ]

    /// Why `path` may hold a password or a key, or nil. `home`: the user's home folder.
    public static func reason(_ path: String, home: String = NSHomeDirectory()) -> String? {
        let real = (path as NSString).resolvingSymlinksInPath
        let base = (home as NSString).resolvingSymlinksInPath
        let name = (real as NSString).lastPathComponent
        let lower = real.lowercased()
        func under(_ rel: String) -> Bool { let root = (base + "/" + rel).lowercased(); return lower == root || lower.hasPrefix(root + "/") }
        for (rel, why) in homeFolders where under(rel) {
            if rel == ".ssh", name.hasSuffix(".pub") || ["config", "known_hosts", "known_hosts.old", "authorized_keys"].contains(name) { return nil }
            return why
        }
        for (rel, why) in homeFiles where lower == (base + "/" + rel).lowercased() { return why }
        if name == ".env" { return "env" }
        if name.lowercased().hasPrefix(".env."), !["example", "sample", "template", "dist"].contains(String(name.dropFirst(5)).lowercased()) { return "env" }
        let ext = (name as NSString).pathExtension.lowercased()
        if ["pem", "key", "p12", "pfx", "keychain-db", "keystore", "jks"].contains(ext) { return "key" }
        if ["id_rsa", "id_ecdsa", "id_ed25519", "id_dsa", "id_ecdsa_sk", "id_ed25519_sk"].contains(name) { return "key" }
        return nil
    }

    /// What the card and the alert say before such files go to an agent (files-v0 §4).
    public static func question(names: [String]) -> String {
        let listed = names.map { "`\($0)`" }.joined(separator: "、")
        let lead = names.count == 1 ? "\(listed) 可能含有密码或密钥。" : "这 \(names.count) 个文件可能含有密码或密钥：\(listed)。"
        return lead + "交给 agent 后，它能读到其中的内容，并可能发给模型的服务商。"
    }
}
