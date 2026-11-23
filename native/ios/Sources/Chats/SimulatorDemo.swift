#if targetEnvironment(simulator)
import UIKit

/// Made-up chats for looking at the list in the simulator while there is no account behind it yet.
/// Compiled for the simulator only: a build for a phone does not contain this file's contents.
enum SimulatorDemo {
    static func chats() -> [ChatRow] {
        let people: [(String, String, String, UInt32, Int, Bool, Bool, Int, String)] = [
            ("Алиса Воронцова", "Тогда до завтра, я принесу распечатки", "09:38", 0x5E7BFF, 2, false, true, 0, "Закреплённые"),
            ("Команда запуска", "Игорь: сборка прошла, смотрю снимки", "09:12", 0x34C3A0, 14, false, false, 0, "Сегодня"),
            ("Мама", "Позвони, как освободишься", "08:47", 0xE86F9B, 0, false, false, 2, ""),
            ("Дмитрий Орлов", "Голосовое сообщение", "08:05", 0xF2A33C, 0, false, false, 1, ""),
            ("Книжный клуб", "Вера: в четверг обсуждаем третью главу", "Вчера", 0x9B6BF2, 131, true, false, 0, "Вчера"),
            ("Саша", "Ок", "Вчера", 0x3CA7F2, 0, false, false, 2, ""),
            ("Поддержка", "Спасибо, вопрос решён", "Пн", 0x7A8699, 0, false, false, 0, "Раньше"),
            ("Марина Ким", "Фото", "Пн", 0xF26B5E, 0, false, false, 0, ""),
            ("Лев", "Пришли адрес ещё раз, пожалуйста", "12.11", 0x4FB86A, 0, false, false, 2, ""),
        ]
        let rows: [[String: Any]] = people.enumerated().map { index, person -> [String: Any] in
            let (title, preview, time, color, unread, muted, pinned, ticks, section) = person
            let orb = orbPair(color)
            let initials = Messenger.initials(title) // the real rows' rule (upper case, as the reference's Avatar)
            return ["id": "demo-\(index)", "title": title, "preview": preview, "time": time, "unread": unread, "muted": muted, "pinned": pinned, "ticks": ticks,
                    "avatarColor": Int(0xFF00_0000 | color), "initials": initials, "orbA": orb.light, "orbB": orb.deep, "section": section,
                    "previewIcon": preview == "Голосовое сообщение" ? "mic" : ""]
        }
        return ChatRow.parse(rows)
    }

    static func messages() -> [[String: Any]] {
        let said: [(Bool, String, String)] = [
            (false, "Привет! Ты завтра будешь на встрече?", "09:12"),
            (true, "Привет. Да, к десяти подойду", "09:14"),
            (false, "Отлично. Я подготовила короткий план — три пункта, должно уложиться в полчаса, если никто не уйдёт в детали", "09:15"),
            (true, "Хорошо", "09:15"),
            (true, "Распечатки нужны или хватит экрана?", "09:16"),
            (false, "Лучше распечатки, там таблица", "09:30"),
            (false, "Тогда до завтра, я принесу распечатки", "09:38"),
        ]
        var rows: [[String: Any]] = [["key": "day", "kind": 1, "text": "Сегодня"]]
        for (index, line) in said.enumerated() {
            let last = index + 1 == said.count || said[index + 1].0 != line.0
            rows.append(["key": "m\(index)", "kind": 0, "mine": line.0, "text": line.1, "time": line.2, "ticks": line.0 ? 2 : 0, "tail": last])
        }
        return rows
    }
}
#endif
