//! Old chats on a new device: who sends what, when (docs/HISTORY-TRANSFER.md).
//!
//! Reference: `mobile/src/e2ee/historySync.ts`, step for step. The server calls are the reference's `Api` members
//! (`requestHistory`, `claimHistory`, … — the table in `api.rs`), made through the app's own transport; the pages
//! are sealed by `history` with the Signal library's AES-256-GCM-SIV; the messages come from and go into the
//! encryption service's vault (`history_export` / `history_import`); keys travel only in Signal notes between the
//! account's own devices (`seal_note_in` / `open_note_in`, lane `history`).

use super::bridge::{CryptoTransport, Env, SignalBridge, Vault};
use super::history::{self, PageCipher};
use super::service::{Crypto, CryptoError, HISTORY_EXPORT_CHARS};
use crate::json::{self, JsString, Value};

/// The server's refusal (or silence), as the app's transport hands it over.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal { pub network: bool, pub message: String, pub code: Option<String>, pub status: f64 }

/// The server's history routes: `op` is the name of the `Api` member, `args` its arguments.
pub trait HistoryServer { fn call(&mut self, op: &str, args: Vec<Value>) -> Result<Value, Refusal>; }

#[derive(Clone, Debug, PartialEq)]
pub enum SyncError {
    Crypto(CryptoError),
    Server(Refusal),
    /// Words for the person.
    Message(String),
    /// A restore refused: the words and, when the server counted the attempt, how many are left this hour.
    Restore(String, Option<f64>),
}
impl SyncError {
    pub fn name(&self) -> &str { match self { SyncError::Crypto(error) => error.name(), SyncError::Server(refusal) if refusal.network => "NetworkError", SyncError::Restore(..) => "RestoreError", _ => "Error" } }
    pub fn message(&self) -> String { match self { SyncError::Crypto(error) => error.message().to_string(), SyncError::Server(refusal) => refusal.message.clone(), SyncError::Message(text) | SyncError::Restore(text, _) => text.clone() } }
    pub fn code(&self) -> Option<&str> { match self { SyncError::Server(refusal) => refusal.code.as_deref(), _ => None } }
}
impl From<CryptoError> for SyncError { fn from(error: CryptoError) -> Self { SyncError::Crypto(error) } }
impl From<Refusal> for SyncError { fn from(refusal: Refusal) -> Self { SyncError::Server(refusal) } }
type Outcome<T> = Result<T, SyncError>;
fn words<T>(text: &str) -> Outcome<T> { Err(SyncError::Message(text.to_string())) }

/// Everything a step needs: the encryption service, the server, the cipher of the pages.
pub struct History<'a, S: SignalBridge, V: Vault, T: CryptoTransport, E: Env> {
    pub crypto: &'a mut Crypto<S, V, T, E>,
    pub server: &'a mut dyn HistoryServer,
    pub cipher: &'a dyn PageCipher,
}

fn text(value: Option<&Value>) -> String { value.and_then(Value::as_str).unwrap_or_default() }
fn number(value: Option<&Value>) -> f64 { match value { Some(Value::Number(n)) => *n, _ => f64::NAN } }
fn put(object: &mut Value, key: &str, value: Option<Value>) {
    let Value::Object(entries) = object else { return };
    let key = JsString::from_str(key);
    match value {
        Some(value) => match entries.iter_mut().find(|(name, _)| *name == key) { Some(entry) => entry.1 = value, None => entries.push((key, value)) },
        None => entries.retain(|(name, _)| *name != key),
    }
}

impl<S: SignalBridge, V: Vault, T: CryptoTransport, E: Env> History<'_, S, V, T, E> {
    /// The vault's `history:v1`: whether a copy was asked for, the backup secret and marks, a copy being imported.
    pub fn state(&self) -> Value {
        match self.crypto.load_local("history:v1").map(|text| json::parse(&text)) { Some(Ok(value @ Value::Object(_))) => value, _ => json::object(vec![]) }
    }
    fn save(&mut self, change: Vec<(&str, Option<Value>)>) -> Value {
        let mut next = self.state();
        for (key, value) in change { put(&mut next, key, value) }
        self.crypto.store_local("history:v1", &json::stringify(&next));
        next
    }
    fn device_id(&mut self) -> Outcome<String> {
        self.crypto.initialize()?;
        match self.crypto.device_id() { Some(id) => Ok(id), None => words("Шифрование не готово.") }
    }

    // ── Variant A ──────────────────────────────────────────────────────────────────────────────────────────────

    /// On a device without any cached chat: asks for a copy once. The request, or null.
    pub fn ask(&mut self) -> Outcome<Value> {
        if matches!(self.state().get("asked"), Some(Value::Bool(true))) { return Ok(Value::Null) }
        let device = self.device_id()?;
        if !self.crypto.history_chats().is_empty() { self.save(vec![("asked", Some(Value::Bool(true)))]); return Ok(Value::Null) }
        match self.server.call("requestHistory", vec![Value::str(&device)]) {
            Ok(answer) => { self.save(vec![("asked", Some(Value::Bool(true)))]); Ok(answer.get("transfer").cloned().unwrap_or(Value::Null)) }
            Err(refusal) if refusal.code.as_deref() == Some("HISTORY_NO_SOURCE") => { self.save(vec![("asked", Some(Value::Bool(true)))]); Ok(Value::Null) }
            Err(refusal) => Err(refusal.into()),
        }
    }

    /// Sends this device's cached chats to the new device of `transfer` (already past its wait). The pages sent.
    pub fn send(&mut self, transfer: &Value) -> Outcome<f64> {
        let device = self.device_id()?;
        let id = text(transfer.get("id"));
        self.server.call("claimHistory", vec![Value::str(&id), Value::str(&device)])?;
        let key = history::new_page_key();
        let (mut cursor, mut index) = (Value::Null, 0.0);
        loop {
            let batch = self.crypto.history_export(&Value::Null, &cursor, HISTORY_EXPORT_CHARS)?;
            let items = match batch.get("items") { Some(Value::Array(items)) => items.clone(), _ => Vec::new() };
            let next = batch.get("next").cloned().unwrap_or(Value::Null);
            let last = matches!(next, Value::Null) || index + 1.0 >= 1024.0;
            let body = history::seal_page(self.cipher, &key, &history::transfer_ad(&id, index), &items, last, None).map_err(|words| SyncError::Message(words.to_string()))?;
            self.server.call("putHistoryPage", vec![Value::str(&id), Value::Number(index), Value::str(&device), Value::str(&body)])?;
            index += 1.0;
            if last { break }
            cursor = next;
        }
        let note = self.crypto.seal_note_in(&self.crypto.user_id.clone(), &text(transfer.get("targetDeviceId")), &history::transfer_note(&id, &key, index), "history")?;
        self.server.call("completeHistory", vec![Value::str(&id), Value::str(&device), note, Value::Number(index)])?;
        Ok(index)
    }

    /// On an older device: answers every request whose wait is over. The time of the next one still waiting, or null.
    pub fn serve(&mut self) -> Outcome<Value> {
        let device = self.device_id()?;
        let answer = self.server.call("outgoingHistory", vec![Value::str(&device)])?;
        let transfers = match answer.get("transfers") { Some(Value::Array(list)) => list.clone(), _ => Vec::new() };
        let mut next: Option<String> = None;
        for transfer in &transfers {
            if !matches!(transfer.get("ready"), Some(Value::Bool(true))) {
                let at = text(transfer.get("notBefore"));
                if next.as_ref().is_none_or(|held| at < *held) { next = Some(at) }
                continue;
            }
            let source = text(transfer.get("sourceDeviceId"));
            if text(transfer.get("state")) == "sending" && !source.is_empty() && source != device { continue }
            match self.send(transfer) {
                Ok(_) => {}
                // Another device took it, or the new device left / was cancelled meanwhile: nothing to do here.
                Err(SyncError::Server(refusal)) if matches!(refusal.code.as_deref(), Some("HISTORY_CLAIMED" | "HISTORY_CLOSED" | "HISTORY_TOO_EARLY")) || [403.0, 404.0, 409.0, 410.0].contains(&refusal.status) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(next.map_or(Value::Null, |at| Value::str(&at)))
    }

    /// On the new device: imports a completed copy. The messages imported, or null when none is ready.
    pub fn receive(&mut self, mut on_page: impl FnMut(f64, f64)) -> Outcome<Value> {
        let device = self.device_id()?;
        let answer = self.server.call("incomingHistory", vec![Value::str(&device)])?;
        let transfer = answer.get("transfer").cloned().unwrap_or(Value::Null);
        let note = transfer.get("note").cloned();
        if matches!(transfer, Value::Null) || text(transfer.get("state")) != "ready" || note.is_none() { return Ok(Value::Null) }
        let id = text(transfer.get("id"));
        // A Signal message opens once: the key stays in the vault until the copy is imported.
        let held = self.state().get("transfer").cloned().filter(|held| text(held.get("id")) == id);
        let held = match held {
            Some(held) => held,
            None => {
                let opened = self.crypto.open_note_in(&self.crypto.user_id.clone(), note.as_ref().expect("checked"), "history")?;
                let Some((key, pages)) = history::parse_transfer_note(&opened, &id) else { return words("Ключ переноса не подходит к этому переносу.") };
                let held = json::object(vec![("id", Value::str(&id)), ("key", Value::str(&key)), ("pageCount", Value::Number(pages)), ("done", Value::Number(0.0)), ("imported", Value::Number(0.0))]);
                self.save(vec![("transfer", Some(held.clone()))]);
                held
            }
        };
        let (key, pages) = (text(held.get("key")), number(held.get("pageCount")));
        if pages != number(transfer.get("pageCount")) { return words("Копия переписок пришла не полностью.") }
        let mut imported = number(held.get("imported"));
        let mut index = number(held.get("done"));
        while index < pages {
            let page = self.server.call("historyPage", vec![Value::str(&id), Value::Number(index), Value::str(&device)])?;
            let (items, last) = history::open_page(self.cipher, &key, &history::transfer_ad(&id, index), &text(page.get("body"))).map_err(|words| SyncError::Message(words.to_string()))?;
            if last != (index == pages - 1.0) { return words("Копия переписок пришла не полностью.") }
            imported += number(self.crypto.history_import(&Value::Array(items))?.get("imported"));
            let mut progress = held.clone();
            put(&mut progress, "done", Some(Value::Number(index + 1.0)));
            put(&mut progress, "imported", Some(Value::Number(imported)));
            self.save(vec![("transfer", Some(progress))]);
            on_page(index + 1.0, pages);
            index += 1.0;
        }
        self.server.call("ackHistory", vec![Value::str(&id), Value::str(&device)])?;
        let total = match self.state().get("imported") { Some(Value::Number(n)) => *n, _ => 0.0 } + imported;
        self.save(vec![("transfer", None), ("imported", Some(Value::Number(total)))]);
        Ok(Value::Number(imported))
    }

    // ── Variant B ──────────────────────────────────────────────────────────────────────────────────────────────

    /// Turns the backup on with a new secret made here (or starts a new secret). The secret to show.
    pub fn enable(&mut self) -> Outcome<String> {
        let device = self.device_id()?;
        let state = self.server.call("backupState", vec![Value::str(&device)])?;
        let secret = history::new_backup_secret();
        let user = self.crypto.user_id.clone();
        let Some((_, check)) = history::backup_keys(&secret, &text(state.get("salt")), &user) else { return words("Неверный ключ резервной копии.") };
        let enabled = self.server.call("enableBackup", vec![Value::str(&device), Value::Number(number(state.get("generation")) + 1.0), Value::str(&check)])?;
        self.save(vec![("secret", Some(Value::str(&secret))), ("generation", enabled.get("generation").cloned()), ("marks", Some(json::object(vec![])))]);
        Ok(secret)
    }

    pub fn disable(&mut self) -> Outcome<()> {
        let device = self.device_id()?;
        self.server.call("disableBackup", vec![Value::str(&device)])?;
        self.save(vec![("secret", None), ("generation", None), ("marks", None)]);
        Ok(())
    }

    /// The secret this device holds for the backup as it is now (taking a sealed copy from another device if one
    /// came), or null.
    pub fn secret(&mut self, known: Option<&Value>) -> Outcome<Option<String>> {
        let device = self.device_id()?;
        let server = match known { Some(state) => state.clone(), None => self.server.call("backupState", vec![Value::str(&device)])? };
        let local = self.state();
        if !matches!(server.get("enabled"), Some(Value::Bool(true))) { return Ok(None) }
        if matches!(local.get("secret"), Some(Value::String(_))) && number(local.get("generation")) == number(server.get("generation")) { return Ok(Some(text(local.get("secret")))) }
        let Some(note) = server.get("note").cloned() else { return Ok(None) };
        let user = self.crypto.user_id.clone();
        let opened = self.crypto.open_note_in(&user, &note, "history")?;
        let Some((generation, secret)) = history::parse_secret_note(&opened, &user) else { return words("Ключ резервной копии повреждён.") };
        if generation != number(server.get("generation")) { return Ok(None) }
        self.save(vec![("secret", Some(Value::str(&secret))), ("generation", Some(Value::Number(generation))), ("marks", Some(json::object(vec![])))]);
        Ok(Some(secret))
    }

    /// Keeps the backup going from this device: hands the secret to own devices still without it, then appends what
    /// is new (only the device writing the log does). The pages written.
    pub fn backup(&mut self) -> Outcome<f64> {
        let device = self.device_id()?;
        let server = self.server.call("backupState", vec![Value::str(&device)])?;
        let Some(secret) = self.secret(Some(&server))? else { return Ok(0.0) };
        let user = self.crypto.user_id.clone();
        let generation = number(server.get("generation"));
        for target in match server.get("missing") { Some(Value::Array(list)) => list.clone(), _ => Vec::new() } {
            let target_id = text(target.get("id"));
            // That device left meanwhile, or its keys could not be used: the next run tries again.
            if let Ok(note) = self.crypto.seal_note_in(&user, &target_id, &history::secret_note(&user, generation, &secret), "history") {
                let _ = self.server.call("putBackupNote", vec![Value::str(&device), Value::str(&target_id), Value::Number(generation), note]);
            }
        }
        // Another device may write the log: the server refuses this one (BACKUP_WRITER) until that writer goes quiet.
        let Some((key, _)) = history::backup_keys(&secret, &text(server.get("salt")), &user) else { return words("Неверный ключ резервной копии.") };
        let mut marks = self.state().get("marks").cloned().filter(|marks| matches!(marks, Value::Object(_))).unwrap_or_else(|| json::object(vec![]));
        let (mut reset, mut cursor, mut written) = (false, Value::Null, 0.0);
        loop {
            let after = if reset { Value::Null } else { marks.clone() };
            let batch = self.crypto.history_export(&after, &cursor, HISTORY_EXPORT_CHARS)?;
            let items = match batch.get("items") { Some(Value::Array(items)) => items.clone(), _ => Vec::new() };
            if items.is_empty() { break }
            let body = history::seal_page(self.cipher, &key, &history::backup_ad(&user, generation), &items, false, None).map_err(|words| SyncError::Message(words.to_string()))?;
            match self.server.call("appendBackupPage", vec![Value::str(&device), Value::Number(generation), Value::str(&body), Value::Bool(reset && written == 0.0)]) {
                Ok(_) => {}
                Err(refusal) if refusal.code.as_deref() == Some("BACKUP_WRITER") => return Ok(written),
                // Full: start the log again from this device's whole cache.
                Err(refusal) if refusal.code.as_deref() == Some("BACKUP_FULL") && !reset => { reset = true; marks = json::object(vec![]); cursor = Value::Null; written = 0.0; continue }
                Err(refusal) => return Err(refusal.into()),
            }
            written += 1.0;
            if let Some(Value::Object(new_marks)) = batch.get("marks") {
                for (chat, mark) in new_marks {
                    let held = marks.get(&chat.to_string_lossy()).and_then(Value::as_str);
                    let mark_text = mark.as_str().unwrap_or_default();
                    if held.as_ref().is_none_or(|held| held.encode_utf16().cmp(mark_text.encode_utf16()) == std::cmp::Ordering::Less) { put(&mut marks, &chat.to_string_lossy(), Some(Value::str(&mark_text))) }
                }
            }
            self.save(vec![("marks", Some(marks.clone()))]);
            let next = batch.get("next").cloned().unwrap_or(Value::Null);
            if matches!(next, Value::Null) { break }
            cursor = next;
        }
        Ok(written)
    }

    /// On a new device: the typed (or scanned) secret → the backup is downloaded, decrypted and imported.
    pub fn restore(&mut self, typed: &str, mut on_page: impl FnMut(f64, f64)) -> Outcome<f64> {
        let Some(secret) = history::parse_secret(typed) else { return Err(SyncError::Restore("Ключ введён с ошибкой. Проверь символы — попытка не потрачена.".to_string(), None)) };
        let device = self.device_id()?;
        let start = self.server.call("startRestore", vec![Value::str(&device)])?;
        let user = self.crypto.user_id.clone();
        let left = number(start.get("attemptsLeft"));
        let Some((key, check)) = history::backup_keys(&secret, &text(start.get("salt")), &user) else { return words("Неверный ключ резервной копии.") };
        if check != text(start.get("keyCheck")) { return Err(SyncError::Restore(format!("Ключ не подходит к резервной копии этого аккаунта. Осталось попыток: {}.", json::number_text(left)), Some(left))) }
        let (generation, pages) = (number(start.get("generation")), number(start.get("pageCount")));
        let mut imported = 0.0;
        let mut index = 0.0;
        while index < pages {
            let page = self.server.call("backupPage", vec![Value::Number(index), Value::str(&device)])?;
            let (items, _) = history::open_page(self.cipher, &key, &history::backup_ad(&user, generation), &text(page.get("body"))).map_err(|words| SyncError::Message(words.to_string()))?;
            imported += number(self.crypto.history_import(&Value::Array(items))?.get("imported"));
            on_page(index + 1.0, pages);
            index += 1.0;
        }
        let total = match self.state().get("imported") { Some(Value::Number(n)) => *n, _ => 0.0 } + imported;
        self.save(vec![("secret", Some(Value::str(&secret))), ("generation", Some(Value::Number(generation))), ("marks", Some(json::object(vec![]))), ("asked", Some(Value::Bool(true))), ("imported", Some(Value::Number(total)))]);
        Ok(imported)
    }
}
