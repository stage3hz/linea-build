// The shared core's C functions (native/core/src/ffi.rs). Every text handed out is given back with
// invizent_string_free.
#ifndef INVIZENT_CORE_H
#define INVIZENT_CORE_H
char *invizent_core_version(void);
char *invizent_safety_code(const char *pair_json);
void invizent_string_free(char *text);
#endif
