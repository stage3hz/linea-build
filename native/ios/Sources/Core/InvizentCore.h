// The shared core's C functions (native/core/src/ffi.rs). Every text handed out is given back with
// invizent_string_free.
#ifndef INVIZENT_CORE_H
#define INVIZENT_CORE_H
char *invizent_core_version(void);
char *invizent_safety_code(const char *pair_json);
void invizent_string_free(char *text);

#include <stdbool.h>
#include <stdint.h>
// Requests to the server: the headers and time limit of a request, and what an answer means.
char *invizent_http_prepare(const char *request_json);
char *invizent_http_read(uint16_t status, const char *body);
#endif
