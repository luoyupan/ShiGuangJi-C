#ifndef SGJ_API_H
#define SGJ_API_H
#include "sgj.h"

/* body: {"channel":"...","args":[...]} */
int api_handle(const char *body_json, char **out_json, char **out_error);

#endif
