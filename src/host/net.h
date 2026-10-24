#ifndef SGJ_NET_H
#define SGJ_NET_H
#include "sgj.h"

typedef struct {
  char *data;
  size_t len;
  int status;
  char error[256];
} HttpResult;

int http_request_ex(const char *method, const char *url, const char *headers,
                    const void *body, size_t body_len, int timeout_ms, HttpResult *out);
void http_result_free(HttpResult *r);

#endif
