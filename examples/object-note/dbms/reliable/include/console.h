#ifndef CONSOLE_H
#define CONSOLE_H
/* Mini DB 콘솔의 순수한 부분: 문장 끊기, 표시 폭 계산, 결과 출력.
 * 입력 루프와 명령(.quit 등)은 console.c, 엔진 호출은 mdb_execute 하나뿐이다. */
#include "mdb.h"
#include <stdio.h>

/* ---- 문장 끊기: 글자를 하나씩 넣는다. 작은따옴표 안의 ;는 문장의 끝이 아니다.
 * 따옴표 안의 작은따옴표는 '' 로 쓰므로, 따옴표 상태를 글자마다 뒤집기만 하면 맞게 동작한다. */
typedef struct {
    char sql[MDB_SQL_MAX + 1];
    size_t len;
    int quoted;   /* 지금 작은따옴표 안인가 */
    int overflow; /* 길이 한도를 넘어서 이 문장은 버리는 중이다 */
} con_splitter;
typedef enum {
    CON_MORE,      /* 문장이 아직 끝나지 않았다 */
    CON_STATEMENT, /* 한 문장이 끝났다: s->sql 에 ;까지 들어 있다 (reset 하기 전까지만 유효) */
    CON_EMPTY,     /* ; 만 있는 빈 문장이었다. 무시한다 */
    CON_TOO_LONG   /* 한도(MDB_SQL_MAX 바이트)를 넘은 문장이 끝났다. 버려졌다 */
} con_feed_result;
void con_splitter_reset(con_splitter *s);
con_feed_result con_feed(con_splitter *s, unsigned char ch);
/* 아직 끝나지 않은 입력이 있는가 (앞쪽 공백은 세지 않는다) */
int con_pending(const con_splitter *s);

/* ---- 표시 폭: 터미널 칸 수. 한글·한자 등은 2칸, 결합 문자는 0칸 */
size_t con_display_width(const char *text);

/* ---- 결과 출력
 * out: 표와 성공 메시지, err: 오류와 안내. 문장을 실행한 뒤 한 번 부른다.
 * sql 은 실행한 문장(오류 위치를 가리키는 데 쓴다), rc 는 mdb_execute 의 반환값, ms 는 걸린 시간 */
void con_print_table(FILE *out, const mdb_result *r);
void con_report(FILE *out, FILE *err, const char *sql, int rc, const mdb_result *r, double ms);
/* 문자열을 표에 넣기 좋게 바꾼다: 줄바꿈·탭 같은 제어 문자는 \n \t \xNN 으로 보인다. free()로 해제 */
char *con_escape_cell(const char *text);
#endif
