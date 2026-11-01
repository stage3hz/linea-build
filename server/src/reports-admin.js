import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * Reports for the server administrator (deploy/reports.sh). Chats are end-to-end encrypted,
 * so a report holds only who reported whom, the reason and an optional comment — never messages.
 *   list [--all]        open reports (or all), newest first
 *   resolve --id <id>   mark a report as handled
 */
const REASONS = { spam: 'Спам', abuse: 'Оскорбления и травля', violence: 'Насилие', sexual: 'Откровенный контент', illegal: 'Незаконное', scam: 'Мошенничество', other: 'Другое' };

export function listReports(db, { all = false, limit = 100 } = {}) {
  return db.prepare(`SELECT r.id, r.reason, r.comment, r.created_at AS createdAt, r.resolved_at AS resolvedAt, r.community_id AS communityId,
      reporter.username AS reporter, target.username AS target, target.display_name AS targetName,
      (SELECT COUNT(*) FROM reports x WHERE x.target_user_id=r.target_user_id AND x.resolved_at IS NULL) AS openOnTarget
    FROM reports r LEFT JOIN users reporter ON reporter.id=r.reporter_id LEFT JOIN users target ON target.id=r.target_user_id
    ${all ? '' : 'WHERE r.resolved_at IS NULL'} ORDER BY r.created_at DESC LIMIT ?`).all(limit)
    .map(row => ({ ...row, reasonLabel: REASONS[row.reason] || row.reason }));
}

export function resolveReport(db, id, at = new Date().toISOString()) {
  const result = db.prepare('UPDATE reports SET resolved_at=? WHERE id=? AND resolved_at IS NULL').run(at, id);
  if (!result.changes) throw new Error('Жалоба не найдена или уже закрыта');
  return { id, resolvedAt: at };
}

function main(args) {
  const [action, ...rest] = args;
  const option = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const dir = realpathSync(resolve(option('--data-dir') || process.env.DATA_DIR || 'data'));
  const db = new DatabaseSync(join(dir, 'linea.sqlite'), { readOnly: action === 'list' });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (action === 'list') {
      const rows = listReports(db, { all: rest.includes('--all') });
      if (!rows.length) { process.stdout.write('Жалоб нет.\n'); return; }
      for (const r of rows) process.stdout.write(`${r.createdAt}  ${r.id}\n  на @${r.target ?? '(удалён)'} (${r.targetName ?? ''}) от @${r.reporter ?? '(удалён)'} · ${r.reasonLabel}${r.communityId ? ` · сервер ${r.communityId}` : ''}${r.resolvedAt ? ' · закрыта' : ''}\n  открытых жалоб на него: ${r.openOnTarget}${r.comment ? `\n  «${r.comment}»` : ''}\n`);
    } else if (action === 'resolve') {
      const id = option('--id'); if (!id) throw new Error('Нужен --id');
      process.stdout.write(`${JSON.stringify(resolveReport(db, id))}\n`);
    } else throw new Error('Использование: reports-admin.js list [--all] | resolve --id <id> [--data-dir <dir>]');
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
