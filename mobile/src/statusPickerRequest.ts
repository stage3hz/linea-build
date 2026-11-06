// Tapping the status next to your name in Settings opens your profile with the status picker already
// up (Telegram opens its emoji-status picker in place); the profile screen picks the request up.
let pending = false;
export const requestStatusPicker = () => { pending = true; };
export const takeStatusPickerRequest = () => { const was = pending; pending = false; return was; };

// Telegram: «Изм.» on the main Settings screen opens the profile editor directly (not the profile first).
let editPending = false;
export const requestProfileEdit = () => { editPending = true; };
export const takeProfileEditRequest = () => { const was = editPending; editPending = false; return was; };
