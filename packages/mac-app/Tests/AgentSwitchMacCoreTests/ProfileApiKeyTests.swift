import XCTest
@testable import AgentSwitchMacCore

/// A profile that pays by a key (docs/profiles-v0.md §3.6): what is typed, the site the key is sealed for, and what
/// the service says of one.
final class ProfileApiKeyTests: XCTestCase {
    func testTheKeyIsSealedForTheSiteItIsSentTo() {
        var draft = ApiKeyDraft()
        XCTAssertEqual(draft.site(agent: "claude-code"), "https://api.anthropic.com/")
        XCTAssertEqual(draft.site(agent: "codex"), "https://api.openai.com/")
        XCTAssertEqual(draft.site(agent: "agy"), "https://generativelanguage.googleapis.com/", "Antigravity on the Gemini API")
        XCTAssertNil(draft.site(agent: "pi"), "no key for an agent that cannot pay by one here")
        draft.baseUrl = " https://Relay.example:8443/api/v1 "
        XCTAssertEqual(draft.site(agent: "codex"), "https://relay.example:8443/")
        XCTAssertEqual(draft.cleanBaseUrl, "https://Relay.example:8443/api/v1")
        draft.baseUrl = "ftp://relay.example"
        XCTAssertNil(draft.site(agent: "codex"))
        XCTAssertNotNil(draft.problem(agent: "codex"))
        draft.baseUrl = "https://me:pw@relay.example"
        XCTAssertNil(draft.site(agent: "codex"), "no account in the address")
    }

    func testANewOneNeedsANameAndAKeyAKeptOneMayKeepItsKeyWhileTheSiteStays() {
        var draft = ApiKeyDraft()
        XCTAssertFalse(draft.canSave(agent: "claude-code", new: true))
        draft.name = "Relay"
        draft.key = "sk-made-up-0001"
        XCTAssertTrue(draft.canSave(agent: "claude-code", new: true))
        draft.key = "short"
        XCTAssertFalse(draft.canSave(agent: "claude-code", new: true))
        XCTAssertNotNil(draft.problem(agent: "claude-code"))

        // Antigravity: no address typed is Google's own, so a name and a key are enough.
        var agy = ApiKeyDraft()
        agy.name = "Gemini"
        agy.key = "made-up-gemini-key-0001"
        XCTAssertTrue(agy.canSave(agent: "agy", new: true))
        XCTAssertNil(agy.cleanBaseUrl, "nothing sent: the service uses its own default")

        var kept = ApiKeyDraft(ProfileApiInfo(baseUrl: "https://relay.example/api", model: "m1"))
        let site = kept.site(agent: "claude-code")
        XCTAssertEqual(kept.model, "m1")
        XCTAssertTrue(kept.canSave(agent: "claude-code", new: false, keptSite: site), "nothing typed: the key it has")
        kept.baseUrl = "https://relay.example/v2"
        XCTAssertTrue(kept.canSave(agent: "claude-code", new: false, keptSite: site))
        kept.baseUrl = "https://elsewhere.example"
        XCTAssertFalse(kept.canSave(agent: "claude-code", new: false, keptSite: site), "another site: the key sealed for the old one does not go with it")
        kept.key = "sk-made-up-0002"
        XCTAssertTrue(kept.canSave(agent: "claude-code", new: false, keptSite: site))
    }

    func testWhatTheAddressSaidOfItsModels() throws {
        func said(_ json: String) throws -> ProfileModelsAnswer { try JSONDecoder().decode(ProfileModelsAnswer.self, from: Data(json.utf8)) }
        XCTAssertEqual(try said(#"{"models":["gemini-4-neon-high","gemini-4-neon-low"]}"#).models, ["gemini-4-neon-high", "gemini-4-neon-low"])
        XCTAssertNil(try said(#"{"models":["gemini-4-neon-high"]}"#).problem)
        XCTAssertNil(try said(#"{"models":[]}"#).models)
        XCTAssertNotNil(try said(#"{"models":[]}"#).problem)
        XCTAssertEqual(try said(#"{"refused":401}"#), .refused(401))
        XCTAssertEqual(try said(#"{"unlisted":true}"#), .unlisted)
        XCTAssertEqual(try said(#"{"status":500}"#), .status(500))
        XCTAssertEqual(try said(#"{"unreachable":"timed out"}"#), .unreachable("timed out"))
        XCTAssertNil(try said(#"{"refused":403}"#).models)
    }

    func testWhatTheServiceSaysOfOneAndOfTheWaysToSignIn() throws {
        let json = #"{"current":"default","creatable":true,"kinds":["api"],"profiles":[{"id":"default","name":"Default","kind":"subscription","createdAt":0},{"id":"abc123def0","name":"Relay","kind":"api","createdAt":1,"color":"sand","api":{"baseUrl":"https://relay.example/api"}},{"id":"abc123def1","name":"Key","kind":"api","createdAt":2,"api":{}}]}"#
        let list = try JSONDecoder().decode(AgentProfiles.self, from: Data(json.utf8))
        XCTAssertEqual(list.newKinds, ["api"])
        XCTAssertEqual(ProfileWords.who(list.profiles[1]), "API Key · relay.example")
        XCTAssertEqual(ProfileWords.who(list.profiles[2]), "API Key")
        XCTAssertTrue(list.profiles[1].paysByKey)
        // A service from before: no word of the ways, an account alone where profiles can be made.
        let old = try JSONDecoder().decode(AgentProfiles.self, from: Data(#"{"current":"default","creatable":true,"profiles":[]}"#.utf8))
        XCTAssertEqual(old.newKinds, ["subscription"])
        XCTAssertEqual(try JSONDecoder().decode(AgentProfiles.self, from: Data(#"{"current":"default","creatable":false,"profiles":[]}"#.utf8)).newKinds, [])
    }
}
