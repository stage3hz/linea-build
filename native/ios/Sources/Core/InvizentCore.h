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
// The request (method, path, body) of one server operation by its name.
char *invizent_api_call(const char *op, const char *args_json, const char *device_json);

// The encryption service. The app gives it the private storage and the server as functions; every text a
// function gives back is allocated with malloc (strdup) and freed by the core.
typedef struct InvizentHost {
    void *context;
    char *(*bridge)(void *context, const char *method, const char *args);      // null: the core's own Signal library
    char *(*vault_get)(void *context, const char *key);                        // null when there is no record
    void (*vault_commit)(void *context, const char *changes_json);             // [[key, value|null], …], all or none
    char *(*transport)(void *context, const char *method, const char *args);   // {"ok":…} | {"network":"…"} | {"refused":"…"}
    char *(*now_iso)(void *context);                                           // null: the device's clock
    char *(*random_uuid)(void *context);                                       // null: the system's random source
} InvizentHost;
typedef struct InvizentCrypto InvizentCrypto;
InvizentCrypto *invizent_crypto_new(const char *user_id, bool auto_trust, const InvizentHost *host);
char *invizent_crypto_call(InvizentCrypto *crypto, const char *op, const char *args_json);
void invizent_crypto_free(InvizentCrypto *crypto);

// Pure functions of the core by name (foldChat, chatListText, replyPreview): JSON array in, JSON out.
char *invizent_view(const char *name, const char *args_json);

// One session's exchange of device proofs, moved step by step (see ffi.rs: invizent_proof_call).
typedef struct InvizentProof InvizentProof;
InvizentProof *invizent_proof_new(void);
char *invizent_proof_call(InvizentProof *proof, const char *input_json);
void invizent_proof_free(InvizentProof *proof);
#endif
