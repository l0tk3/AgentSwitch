/* pty-hold: holds one terminal's pseudo-terminal and its program so that they outlive the service
 * (docs/terminal-v0.md §10). One process per terminal, like dtach or abduco: it starts the program on a pty, keeps the
 * pty's output in a ring buffer with a byte offset, and serves one client — the daemon — on a Unix socket. When the
 * daemon goes (a restart, an update), the program and this process go on; the next daemon connects, says where it
 * stopped reading, and is sent the rest. macOS and Linux, the same source.
 *
 *   pty-hold <socket>        the spec on stdin (below); prints "ready <pid>\n" or "error <why>\n" on stdout, then
 *                            leaves stdin, stdout and stderr for /dev/null and runs until the program has ended and
 *                            the daemon has collected that (or nobody came for a day)
 *
 * The spec, fields ended by NUL: "agentswitch-pty-hold 1", token, cols, rows, ring bytes, cwd, file, argc, argv…,
 * envc, env… (`NAME=value`). On stdin and not on the command line: the environment carries the terminal's hook token.
 *
 * Wire: frames of a type byte, a 4-byte big-endian length and the payload.
 *   daemon → hold   HELLO   u16 version, u64 offset to send from, the token
 *                   INPUT   bytes for the program
 *                   RESIZE  u16 cols, u16 rows
 *                   SIGNAL  i32 signal, to the program's process group
 *                   COLLECT the program's end is taken note of: exit
 *   hold → daemon   WELCOME u16 version, i32 pid, u16 cols, u16 rows, u64 first offset kept, u64 next offset,
 *                           u8 ended, i32 exit code, i32 signal
 *                   DATA    u64 offset, bytes
 *                   EXIT    i32 exit code, i32 signal
 *                   ERROR   a sentence, then the connection closes
 * Versions only grow: a frame type is never given another meaning. A newer client connecting gets the older version
 * in WELCOME and speaks that. A connection takes the client's place only once its token is right: the daemon connected
 * is not cut off by one that does not know it. */

#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#include <util.h>
#else
#define _GNU_SOURCE
#include <pty.h>
#endif
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

#define VERSION 1
#define MAGIC "agentswitch-pty-hold 1"
#define MAX_SPEC (4 << 20)
#define MAX_FRAME (1 << 20)
#define SEND_CHUNK (64 << 10)
#define HELLO_MS 5000
#define LINGER_S (24 * 3600)

enum { HELLO = 1, INPUT = 2, RESIZE = 3, SIGNAL = 4, COLLECT = 5, WELCOME = 0x81, DATA = 0x82, EXIT = 0x83, ERROR = 0x84 };

static char *sock_path;
static int listen_fd = -1, master = -1;
static pid_t child = -1;
static int ended = 0, exit_code = 0, exit_signal = 0;
static unsigned short cols = 120, rows = 36;
static char *token;

/* Output: the last `cap` bytes, at absolute offsets [end - kept, end). */
static unsigned char *ring;
static size_t cap, kept;
static uint64_t end_off;

/* Input waiting for the pty to take it. */
static unsigned char *inq;
static size_t inq_len, inq_cap;

/* The one client, and one that has connected and not yet said its token: it takes the client's place only once it has
 * (a wrong token never cuts the daemon off). */
static int client = -1, authed = 0;
static int pend = -1;
static long long pend_since;
static unsigned char pend_in[5 + 2 + 8 + 512]; static size_t pend_len;
static unsigned char *cin; static size_t cin_len;              /* frames read so far */
static unsigned char *cout; static size_t cout_len, cout_off;  /* a frame being written */
static uint64_t cursor;                                         /* next offset to send */
static int exit_told = 0;

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void put16(unsigned char *p, unsigned v) { p[0] = v >> 8; p[1] = v; }
static void put32(unsigned char *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
static void put64(unsigned char *p, uint64_t v) { put32(p, (uint32_t)(v >> 32)); put32(p + 4, (uint32_t)v); }
static unsigned get16(const unsigned char *p) { return (unsigned)p[0] << 8 | p[1]; }
static uint32_t get32(const unsigned char *p) { return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3]; }
static uint64_t get64(const unsigned char *p) { return (uint64_t)get32(p) << 32 | get32(p + 4); }

static void nonblock(int fd) { fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK); }
static void cloexec(int fd) { fcntl(fd, F_SETFD, FD_CLOEXEC); }

static void drop_client(void) {
  if (client >= 0) close(client);
  client = -1; authed = 0; cin_len = 0; cout_len = cout_off = 0; exit_told = 0;
}

static void finish(int code) {
  if (sock_path) unlink(sock_path);
  _exit(code);
}

/* A frame queued for the client: only one at a time, the next made when this one is written. */
static void frame(int type, const unsigned char *a, size_t alen, const unsigned char *b, size_t blen) {
  size_t n = 5 + alen + blen;
  unsigned char *f = realloc(cout, n);
  if (!f) { drop_client(); return; }
  cout = f;
  f[0] = (unsigned char)type;
  put32(f + 1, (uint32_t)(alen + blen));
  if (alen) memcpy(f + 5, a, alen);
  if (blen) memcpy(f + 5 + alen, b, blen);
  cout_len = n; cout_off = 0;
}

static void drop_pend(void) {
  if (pend >= 0) close(pend);
  pend = -1; pend_len = 0;
}

/* A refusal to the connection that has not said its token: one short frame, best effort, then it is closed. */
static void refuse_pend(const char *why) {
  unsigned char f[5 + 200];
  size_t n = strlen(why) > 200 ? 200 : strlen(why);
  f[0] = ERROR; put32(f + 1, (uint32_t)n); memcpy(f + 5, why, n);
  (void)!write(pend, f, 5 + n);
  drop_pend();
}

static void error_and_close(const char *why) {
  frame(ERROR, (const unsigned char *)why, strlen(why), NULL, 0);
  /* Best effort: blocking for this one short frame. */
  int fl = fcntl(client, F_GETFL);
  fcntl(client, F_SETFL, fl & ~O_NONBLOCK);
  (void)!write(client, cout, cout_len);
  drop_client();
}

static uint64_t first_kept(void) { return end_off - kept; }

/* The next DATA frame from the ring, from `cursor` (moved up past what is no longer kept). */
static void next_data(void) {
  if (cursor < first_kept()) cursor = first_kept();
  if (cursor >= end_off) return;
  size_t n = (size_t)(end_off - cursor);
  if (n > SEND_CHUNK) n = SEND_CHUNK;
  /* The ring as two runs at most. */
  size_t start = (size_t)(cursor % cap), first = n < cap - start ? n : cap - start;
  unsigned char head[8];
  put64(head, cursor);
  unsigned char *tmp = malloc(n);
  if (!tmp) return;
  memcpy(tmp, ring + start, first);
  if (first < n) memcpy(tmp + first, ring, n - first);
  frame(DATA, head, 8, tmp, n);
  free(tmp);
  cursor += n;
}

static void exit_frame(void) {
  unsigned char p[8];
  put32(p, (uint32_t)exit_code); put32(p + 4, (uint32_t)exit_signal);
  frame(EXIT, p, 8, NULL, 0);
  exit_told = 1;
}

/* Something to write: the frame in hand, else data, else the program's end once all data is out. */
static int want_write(void) {
  if (client < 0 || !authed) return 0;
  if (cout_off < cout_len) return 1;
  cout_len = cout_off = 0;
  if (cursor < end_off) { next_data(); return cout_len > 0; }
  if (ended && !exit_told) { exit_frame(); return 1; }
  return 0;
}

static void flush_client(void) {
  while (client >= 0 && want_write()) {
    ssize_t w = write(client, cout + cout_off, cout_len - cout_off);
    if (w < 0) { if (errno == EAGAIN || errno == EINTR) return; drop_client(); return; }
    cout_off += (size_t)w;
  }
}

static void keep_output(const unsigned char *b, size_t n) {
  for (size_t i = 0; i < n;) {
    size_t at = (size_t)(end_off % cap), run = cap - at < n - i ? cap - at : n - i;
    memcpy(ring + at, b + i, run);
    i += run; end_off += run;
  }
  kept = kept + n > cap ? cap : kept + n;
}

static void read_pty(void) {
  unsigned char buf[16384];
  for (;;) {
    ssize_t r = read(master, buf, sizeof buf);
    if (r > 0) { keep_output(buf, (size_t)r); continue; }
    if (r < 0 && (errno == EAGAIN || errno == EINTR)) return;
    /* EIO (no one has the other end open any more) or EOF. */
    close(master); master = -1;
    return;
  }
}

static void write_pty(void) {
  while (master >= 0 && inq_len) {
    ssize_t w = write(master, inq, inq_len);
    if (w < 0) { if (errno == EAGAIN || errno == EINTR) return; inq_len = 0; return; }
    memmove(inq, inq + w, inq_len - (size_t)w);
    inq_len -= (size_t)w;
  }
}

static void queue_input(const unsigned char *b, size_t n) {
  if (master < 0 || ended) return;
  if (inq_len + n > inq_cap) {
    size_t want = inq_len + n > 2 * inq_cap ? inq_len + n : 2 * inq_cap;
    if (want > (8u << 20)) return;   /* nobody types 8 MB ahead of the program */
    unsigned char *q = realloc(inq, want);
    if (!q) return;
    inq = q; inq_cap = want;
  }
  memcpy(inq + inq_len, b, n);
  inq_len += n;
  write_pty();
}

static void reap(void) {
  if (ended || child < 0) return;
  int status;
  pid_t r = waitpid(child, &status, WNOHANG);
  if (r != child) return;
  ended = 1;
  if (WIFEXITED(status)) exit_code = WEXITSTATUS(status);
  else if (WIFSIGNALED(status)) { exit_signal = WTERMSIG(status); exit_code = 128 + exit_signal; }
  /* What the program wrote last is still in the pty. */
  if (master >= 0) read_pty();
}

static int same(const unsigned char *a, size_t alen, const char *b) {
  size_t blen = strlen(b);
  unsigned char d = alen != blen;
  for (size_t i = 0; i < alen && i < blen; i++) d |= a[i] ^ (unsigned char)b[i];
  return d == 0;
}

/* The waiting connection's HELLO: right, and it becomes the client (the older one, a daemon gone or going, is let go). */
static void on_hello(int type, const unsigned char *p, size_t n) {
  if (type != HELLO || n < 10) { refuse_pend("hello first"); return; }
  unsigned version = get16(p);
  if (version < 1) { refuse_pend("this holder speaks version 1 and up"); return; }
  if (!same(p + 10, n - 10, token)) { refuse_pend("wrong token"); return; }
  drop_client();
  client = pend; pend = -1; pend_len = 0;
  authed = 1;
  {
    cursor = get64(p + 2);
    unsigned char w[2 + 4 + 2 + 2 + 8 + 8 + 1 + 4 + 4];
    put16(w, version < VERSION ? version : VERSION);
    put32(w + 2, (uint32_t)child);
    put16(w + 6, cols); put16(w + 8, rows);
    put64(w + 10, first_kept()); put64(w + 18, end_off);
    w[26] = (unsigned char)ended;
    put32(w + 27, (uint32_t)exit_code); put32(w + 31, (uint32_t)exit_signal);
    frame(WELCOME, w, sizeof w, NULL, 0);
  }
}

static void on_frame(int type, const unsigned char *p, size_t n) {
  switch (type) {
    case INPUT: queue_input(p, n); break;
    case RESIZE:
      if (n >= 4) {
        cols = (unsigned short)get16(p); rows = (unsigned short)get16(p + 2);
        struct winsize ws = { .ws_row = rows, .ws_col = cols };
        if (master >= 0) ioctl(master, TIOCSWINSZ, &ws);
      }
      break;
    case SIGNAL:
      if (n >= 4 && !ended) {
        int sig = (int)get32(p);
        if (kill(-child, sig) < 0) kill(child, sig);
      }
      break;
    case COLLECT:
      if (ended) finish(0);
      break;
    default: break;   /* a newer client's frame this version does not know */
  }
}

static void read_client(void) {
  unsigned char buf[16384];
  ssize_t r = read(client, buf, sizeof buf);
  if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) { drop_client(); return; }
  if (r < 0) return;
  unsigned char *b = realloc(cin, cin_len + (size_t)r);
  if (!b) { drop_client(); return; }
  cin = b;
  memcpy(cin + cin_len, buf, (size_t)r);
  cin_len += (size_t)r;
  size_t at = 0;
  while (client >= 0 && cin_len - at >= 5) {
    uint32_t n = get32(cin + at + 1);
    if (n > MAX_FRAME) { error_and_close("frame too large"); return; }
    if (cin_len - at < 5 + n) break;
    on_frame(cin[at], cin + at + 5, n);
    at += 5 + n;
  }
  if (client >= 0) { memmove(cin, cin + at, cin_len - at); cin_len -= at; }
}

static void read_pend(void) {
  ssize_t r = read(pend, pend_in + pend_len, sizeof pend_in - pend_len);
  if (r == 0 || (r < 0 && errno != EAGAIN && errno != EINTR)) { drop_pend(); return; }
  if (r < 0) return;
  pend_len += (size_t)r;
  if (pend_len < 5) return;
  uint32_t n = get32(pend_in + 1);
  if (n > sizeof pend_in - 5) { refuse_pend("hello too large"); return; }
  if (pend_len < 5 + n) return;
  /* Nothing comes after HELLO before WELCOME: anything more was sent early and is dropped with the buffer. */
  on_hello(pend_in[0], pend_in + 5, n);
}

static void accept_client(void) {
  int fd = accept(listen_fd, NULL, NULL);
  if (fd < 0) return;
  /* One waiting connection at a time: a newer one takes the older one's place in the queue, not the client's. */
  drop_pend();
  nonblock(fd); cloexec(fd);
  pend = fd; pend_len = 0; pend_since = now_ms();
}

/* Spec reading. */
static char *spec; static size_t spec_len, spec_at;
static const char *field(void) {
  if (spec_at >= spec_len) return NULL;
  const char *f = spec + spec_at;
  const char *nul = memchr(f, 0, spec_len - spec_at);
  if (!nul) return NULL;
  spec_at = (size_t)(nul - spec) + 1;
  return f;
}

static void say(const char *line) { (void)!write(1, line, strlen(line)); }
static void fail(const char *why) { char b[512]; snprintf(b, sizeof b, "error %s\n", why); say(b); exit(1); }

/* execvp with the program's own PATH, not this process's. */
static void exec_with_path(const char *file, char *const argv[], char *const envp[]) {
  if (strchr(file, '/')) { execve(file, argv, envp); return; }
  const char *path = "/usr/bin:/bin";
  for (char *const *e = envp; *e; e++) if (strncmp(*e, "PATH=", 5) == 0) path = *e + 5;
  char buf[4096];
  int saved = ENOENT;
  while (*path) {
    const char *colon = strchr(path, ':');
    size_t len = colon ? (size_t)(colon - path) : strlen(path);
    if (len && len + strlen(file) + 2 < sizeof buf) {
      memcpy(buf, path, len); buf[len] = '/'; strcpy(buf + len + 1, file);
      execve(buf, argv, envp);
      if (errno != ENOENT && errno != ENOTDIR) saved = errno;
    }
    path += len + (colon ? 1 : 0);
  }
  errno = saved;
}

int main(int argc, char **argv) {
  if (argc != 2) { fprintf(stderr, "usage: pty-hold <socket>   (the spec on stdin)\n"); return 2; }
  sock_path = argv[1];
  signal(SIGHUP, SIG_IGN);
  signal(SIGPIPE, SIG_IGN);
  (void)setsid();   /* already a session leader when the daemon started it detached */

  /* The spec. */
  spec = malloc(MAX_SPEC);
  if (!spec) fail("out of memory");
  for (ssize_t r; (r = read(0, spec + spec_len, MAX_SPEC - spec_len)) != 0;) {
    if (r < 0) { if (errno == EINTR) continue; fail("cannot read the spec"); }
    spec_len += (size_t)r;
    if (spec_len == MAX_SPEC) fail("spec too large");
  }
  const char *magic = field();
  if (!magic || strcmp(magic, MAGIC) != 0) fail("not a spec of version 1");
  const char *tok = field(), *c = field(), *r = field(), *rb = field(), *cwd = field(), *file = field(), *ac = field();
  if (!tok || !c || !r || !rb || !cwd || !file || !ac || !*tok) fail("spec incomplete");
  token = strdup(tok);
  cols = (unsigned short)atoi(c); rows = (unsigned short)atoi(r);
  cap = (size_t)atol(rb);
  if (cols < 1 || rows < 1 || cap < 4096 || cap > (256u << 20)) fail("spec out of range");
  int n_args = atoi(ac);
  if (n_args < 1 || n_args > 4096) fail("argc out of range");
  char **args = calloc((size_t)n_args + 1, sizeof *args);
  for (int i = 0; i < n_args; i++) { const char *a = field(); if (!a) fail("spec incomplete"); args[i] = (char *)a; }
  const char *ec = field();
  int n_env = ec ? atoi(ec) : -1;
  if (n_env < 0 || n_env > 65536) fail("envc out of range");
  char **envp = calloc((size_t)n_env + 1, sizeof *envp);
  for (int i = 0; i < n_env; i++) { const char *e = field(); if (!e) fail("spec incomplete"); envp[i] = (char *)e; }
  ring = malloc(cap);
  if (!ring || !args || !envp || !token) fail("out of memory");

  /* The socket first: a holder nobody could reach is no use. */
  struct sockaddr_un addr = { .sun_family = AF_UNIX };
  if (strlen(sock_path) >= sizeof addr.sun_path) fail("socket path too long");
  strcpy(addr.sun_path, sock_path);
  listen_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listen_fd < 0) fail("no socket");
  int probe = socket(AF_UNIX, SOCK_STREAM, 0);
  if (probe >= 0 && connect(probe, (struct sockaddr *)&addr, sizeof addr) == 0) fail("another holder has this socket");
  if (probe >= 0) close(probe);
  unlink(sock_path);
  mode_t old = umask(077);
  if (bind(listen_fd, (struct sockaddr *)&addr, sizeof addr) < 0) { umask(old); fail("cannot bind the socket"); }
  umask(old);
  chmod(sock_path, 0600);
  if (listen(listen_fd, 4) < 0) { unlink(sock_path); fail("cannot listen"); }
  nonblock(listen_fd); cloexec(listen_fd);

  /* The program; a pipe that closes on exec says whether exec worked. */
  int ep[2];
  if (pipe(ep) < 0) { unlink(sock_path); fail("no pipe"); }
  cloexec(ep[0]); cloexec(ep[1]);
  struct winsize ws = { .ws_row = rows, .ws_col = cols };
  child = forkpty(&master, NULL, NULL, &ws);
  if (child < 0) { unlink(sock_path); fail("forkpty failed"); }
  if (child == 0) {
    close(ep[0]);
    signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    if (chdir(cwd) < 0) { int e = errno; (void)!write(ep[1], &e, sizeof e); _exit(127); }
    exec_with_path(file, args, envp);
    int e = errno; (void)!write(ep[1], &e, sizeof e);
    _exit(127);
  }
  close(ep[1]);
  int child_errno = 0;
  ssize_t got;
  do got = read(ep[0], &child_errno, sizeof child_errno); while (got < 0 && errno == EINTR);
  close(ep[0]);
  if (got == (ssize_t)sizeof child_errno) {
    waitpid(child, NULL, 0);
    unlink(sock_path);
    char why[300];
    snprintf(why, sizeof why, "cannot start %s: %s", file, strerror(child_errno));
    fail(why);
  }
  nonblock(master); cloexec(master);

  char ready[64];
  snprintf(ready, sizeof ready, "ready %d\n", (int)child);
  say(ready);
  int devnull = open("/dev/null", O_RDWR);
  if (devnull >= 0) { dup2(devnull, 0); dup2(devnull, 1); dup2(devnull, 2); if (devnull > 2) close(devnull); }
  free(spec); spec = NULL;   /* argv and env point into it no more: the child has them */

  long long ended_alone_since = 0;
  for (;;) {
    struct pollfd fds[4];
    int nf = 0, i_listen = -1, i_master = -1, i_client = -1, i_pend = -1;
    fds[nf] = (struct pollfd){ .fd = listen_fd, .events = POLLIN }; i_listen = nf++;
    if (master >= 0) { fds[nf] = (struct pollfd){ .fd = master, .events = POLLIN | (inq_len ? POLLOUT : 0) }; i_master = nf++; }
    if (client >= 0) { fds[nf] = (struct pollfd){ .fd = client, .events = POLLIN | (want_write() ? POLLOUT : 0) }; i_client = nf++; }
    if (pend >= 0) { fds[nf] = (struct pollfd){ .fd = pend, .events = POLLIN }; i_pend = nf++; }
    int pr = poll(fds, (nfds_t)nf, 1000);
    if (pr < 0 && errno != EINTR) finish(1);
    if (pr > 0) {
      if (i_master >= 0 && fds[i_master].revents & (POLLIN | POLLHUP | POLLERR)) read_pty();
      if (i_master >= 0 && master >= 0 && fds[i_master].revents & POLLOUT) write_pty();
      if (i_client >= 0 && client >= 0 && fds[i_client].revents & (POLLIN | POLLHUP | POLLERR)) read_client();
      if (i_pend >= 0 && pend >= 0 && fds[i_pend].revents & (POLLIN | POLLHUP | POLLERR)) read_pend();
      if (fds[i_listen].revents & POLLIN) accept_client();
    }
    reap();
    flush_client();
    if (pend >= 0 && now_ms() - pend_since > HELLO_MS) drop_pend();
    /* Ended and nobody to tell: wait a day for a daemon, then go. */
    if (ended && client < 0) {
      if (!ended_alone_since) ended_alone_since = now_ms();
      else if (now_ms() - ended_alone_since > (long long)LINGER_S * 1000) finish(0);
    } else ended_alone_since = 0;
  }
}
