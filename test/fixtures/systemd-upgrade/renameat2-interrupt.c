#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

typedef int (*renameat2_fn)(int, const char *, int, const char *, unsigned int);

static void wait_at_marker(const char *marker) {
  int fd = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (fd >= 0) {
    (void)write(fd, "ready\n", 6);
    (void)fsync(fd);
    (void)close(fd);
  }
  for (;;) sleep(1);
}

int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags) {
  static renameat2_fn real_renameat2;
  if (!real_renameat2) real_renameat2 = (renameat2_fn)dlsym(RTLD_NEXT, "renameat2");
  if (!real_renameat2) return (int)syscall(SYS_renameat2, olddirfd, oldpath, newdirfd, newpath, flags);

  const char *mode = getenv("SONUVI_FIXTURE_EXCHANGE_INTERRUPT");
  const char *marker = getenv("SONUVI_FIXTURE_EXCHANGE_MARKER");
  int is_exchange = flags == 2 && oldpath && newpath
    && strstr(oldpath, "/var/lib/sonuvi-bootstrap/bootstrap-kit-v2") != NULL
    && (strstr(newpath, "/candidate") != NULL || strstr(newpath, "/previous") != NULL);
  if (is_exchange && marker && strcmp(mode ? mode : "", "before") == 0) wait_at_marker(marker);

  int result = real_renameat2(olddirfd, oldpath, newdirfd, newpath, flags);
  if (result == 0 && is_exchange && marker && strcmp(mode ? mode : "", "after") == 0) wait_at_marker(marker);
  return result;
}
