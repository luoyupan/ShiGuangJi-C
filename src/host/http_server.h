#ifndef SGJ_HTTP_H
#define SGJ_HTTP_H
#include "sgj.h"

int http_server_start(const char *ui_dir, const char *token, int port);
void http_server_stop(void);
int http_server_port(void);
char *http_local_url(const char *path);

/* 事件推送（SSE） */
void bus_emit_json(const char *channel, const char *payload_json);
void bus_emit(const char *channel, cJSON *payload);

#endif
