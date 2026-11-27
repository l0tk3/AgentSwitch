import AgentSwitchLive
import Foundation

extension ChannelsSnapshot {
    /// The home screen widget's copy of the rooms list (docs/app-v0.md §6), in the list's order.
    public init(_ list: RoomList, classic: Bool, savedAt: Date = Date()) {
        self.init(channels: list.ordered.map { room in
            Channel(id: room.id, name: room.name, desk: room.desk, paused: room.paused, unread: room.unread, forYou: room.forYou,
                    attention: room.attention,
                    from: room.last.map { $0.from == RoomSeat.you ? "You" : $0.from },
                    text: ChannelsSnapshot.line(room.last?.text ?? room.topic),
                    at: room.last.map { Date(timeIntervalSince1970: TimeInterval($0.at) / 1000) })
        }, classic: classic, savedAt: savedAt)
    }
}
