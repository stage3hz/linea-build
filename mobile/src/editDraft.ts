/**
 * «Изменить» (Telegram): the message is edited in a field of its own; the chat's draft is never written
 * while editing, so leaving the chat mid-edit (or cancelling) keeps what was typed before, and no part of
 * the edit can later be sent as a new message.
 */
export const composerValue = (editing: boolean, editText: string, draft: string | undefined) => editing ? editText : draft || '';
/** Where typed text goes: the edit while editing, otherwise the chat's draft. */
export const typedInto = (editing: boolean, value: string, into: { edit: (value: string) => void; draft: (value: string) => void }) => { if (editing) into.edit(value); else into.draft(value); };
