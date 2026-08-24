#define _DARWIN_C_SOURCE 1

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define CAPSULE_MAGIC UINT32_C(0x44534843)
#define CAPSULE_VERSION UINT16_C(1)
#define SPEC_TYPE UINT16_C(1)
#define COMMAND_CONFIRM UINT16_C(2)
#define COMMAND_RESUME UINT16_C(3)
#define COMMAND_TERMINATE UINT16_C(4)
#define COMMAND_RELEASE UINT16_C(5)
#define EVENT_PREPARED UINT16_C(101)
#define EVENT_CONFIRMED UINT16_C(102)
#define EVENT_RESUMED UINT16_C(103)
#define EVENT_EXIT UINT16_C(104)
#define EVENT_GROUP_ZERO UINT16_C(105)
#define EVENT_RELEASED UINT16_C(106)
#define EVENT_ERROR UINT16_C(255)

typedef struct __attribute__((packed)) {
  uint32_t magic;
  uint16_t version;
  uint16_t type;
  uint32_t total_bytes;
  uint32_t argc;
  uint32_t envc;
  uint32_t grace_ms;
  int32_t ipc_fd;
  uint32_t reserved;
} SpecHeader;

typedef struct __attribute__((packed)) {
  uint32_t magic;
  uint16_t version;
  uint16_t type;
} CommandFrame;

typedef struct __attribute__((packed)) {
  uint32_t magic;
  uint16_t version;
  uint16_t type;
  int32_t status;
  int32_t pid;
  int32_t pgid;
  int32_t exit_code;
  int32_t signal_number;
  uint32_t reserved;
} EventFrame;

_Static_assert(sizeof(SpecHeader) == 32, "SpecHeader ABI");
_Static_assert(sizeof(CommandFrame) == 8, "CommandFrame ABI");
_Static_assert(sizeof(EventFrame) == 32, "EventFrame ABI");

typedef struct {
  char *cwd;
  char **argv;
  uint32_t argc;
  char **envp;
  uint32_t envc;
  uint32_t grace_ms;
  int ipc_fd;
} TargetSpec;

static int read_exact(int fd, void *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(fd, (char *)buffer + offset, length - offset);
    if (count == 0) return 0;
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    offset += (size_t)count;
  }
  return 1;
}

static int write_exact(int fd, const void *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, (const char *)buffer + offset, length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    offset += (size_t)count;
  }
  return 0;
}

static void send_event(int fd, uint16_t type, int status, pid_t pid, pid_t pgid,
                       int exit_code, int signal_number) {
  EventFrame frame = {
    .magic = CAPSULE_MAGIC,
    .version = CAPSULE_VERSION,
    .type = type,
    .status = status,
    .pid = (int32_t)pid,
    .pgid = (int32_t)pgid,
    .exit_code = exit_code,
    .signal_number = signal_number,
    .reserved = 0,
  };
  (void)write_exact(fd, &frame, sizeof(frame));
}

static void free_spec(TargetSpec *spec) {
  if (spec->argv != NULL) {
    for (uint32_t i = 0; i < spec->argc; i++) free(spec->argv[i]);
  }
  if (spec->envp != NULL) {
    for (uint32_t i = 0; i < spec->envc; i++) free(spec->envp[i]);
  }
  free(spec->argv);
  free(spec->envp);
  free(spec->cwd);
  memset(spec, 0, sizeof(*spec));
}

static int parse_string(const uint8_t *payload, size_t length, size_t *offset, char **output) {
  if (*offset > length || length - *offset < sizeof(uint32_t)) return -1;
  uint32_t string_length = 0;
  memcpy(&string_length, payload + *offset, sizeof(string_length));
  *offset += sizeof(string_length);
  if (*offset > length || string_length > length - *offset) return -1;
  char *value = calloc((size_t)string_length + 1, 1);
  if (value == NULL) return -1;
  if (string_length > 0) memcpy(value, payload + *offset, string_length);
  if (memchr(value, '\0', string_length) != NULL) {
    free(value);
    return -1;
  }
  *offset += string_length;
  *output = value;
  return 0;
}

static int read_spec(size_t maximum, TargetSpec *spec) {
  SpecHeader header;
  int result = read_exact(STDIN_FILENO, &header, sizeof(header));
  if (result != 1 || header.magic != CAPSULE_MAGIC || header.version != CAPSULE_VERSION ||
      header.type != SPEC_TYPE || header.total_bytes < sizeof(header) ||
      header.total_bytes > maximum || header.argc == 0 ||
      header.argc > header.total_bytes / sizeof(uint32_t) ||
      header.envc > header.total_bytes / (sizeof(uint32_t) * 2)) return -1;
  size_t payload_length = header.total_bytes - sizeof(header);
  uint8_t *payload = malloc(payload_length == 0 ? 1 : payload_length);
  if (payload == NULL || read_exact(STDIN_FILENO, payload, payload_length) != 1) {
    free(payload);
    return -1;
  }
  spec->argc = header.argc;
  spec->envc = header.envc;
  spec->grace_ms = header.grace_ms;
  spec->ipc_fd = header.ipc_fd;
  spec->argv = calloc((size_t)spec->argc + 1, sizeof(char *));
  spec->envp = calloc((size_t)spec->envc + 1, sizeof(char *));
  size_t offset = 0;
  if (spec->argv == NULL || spec->envp == NULL ||
      parse_string(payload, payload_length, &offset, &spec->cwd) != 0) goto invalid;
  for (uint32_t i = 0; i < spec->argc; i++) {
    if (parse_string(payload, payload_length, &offset, &spec->argv[i]) != 0) goto invalid;
  }
  for (uint32_t i = 0; i < spec->envc; i++) {
    char *key = NULL;
    char *value = NULL;
    if (parse_string(payload, payload_length, &offset, &key) != 0 ||
        parse_string(payload, payload_length, &offset, &value) != 0 ||
        key[0] == '\0' || strchr(key, '=') != NULL) {
      free(key);
      free(value);
      goto invalid;
    }
    size_t key_length = strlen(key);
    size_t value_length = strlen(value);
    if (key_length > SIZE_MAX - value_length - 2) {
      free(key);
      free(value);
      goto invalid;
    }
    spec->envp[i] = malloc(key_length + value_length + 2);
    if (spec->envp[i] == NULL) {
      free(key);
      free(value);
      goto invalid;
    }
    memcpy(spec->envp[i], key, key_length);
    spec->envp[i][key_length] = '=';
    memcpy(spec->envp[i] + key_length + 1, value, value_length + 1);
    free(key);
    free(value);
  }
  free(payload);
  if (offset != payload_length || spec->cwd[0] == '\0' || spec->argv[0][0] == '\0' ||
      spec->grace_ms == 0) goto invalid_without_payload;
  return 0;

invalid:
  free(payload);
invalid_without_payload:
  free_spec(spec);
  return -1;
}

static int parse_positive_option(const char *argument, const char *prefix, long *value) {
  size_t prefix_length = strlen(prefix);
  if (strncmp(argument, prefix, prefix_length) != 0) return 0;
  char *end = NULL;
  errno = 0;
  long parsed = strtol(argument + prefix_length, &end, 10);
  if (errno != 0 || end == argument + prefix_length || *end != '\0' || parsed <= 0) return -1;
  *value = parsed;
  return 1;
}

static int command_valid(const CommandFrame *command, uint16_t type) {
  return command->magic == CAPSULE_MAGIC && command->version == CAPSULE_VERSION && command->type == type;
}

static void close_target_fds(int preserved_fd) {
  long maximum = sysconf(_SC_OPEN_MAX);
  if (maximum < 0 || maximum > INT_MAX) maximum = 1024;
  for (int fd = 3; fd < (int)maximum; fd++) {
    if (fd != preserved_fd) close(fd);
  }
}

static void target_main(const TargetSpec *spec) {
  (void)signal(SIGTERM, SIG_DFL);
  (void)signal(SIGINT, SIG_DFL);
  (void)signal(SIGHUP, SIG_DFL);
  if (dup2(3, STDIN_FILENO) < 0 || dup2(4, STDOUT_FILENO) < 0 || dup2(5, STDERR_FILENO) < 0 ||
      chdir(spec->cwd) != 0) _exit(126);
  close_target_fds(spec->ipc_fd);
  if (raise(SIGSTOP) != 0) _exit(126);
  execve(spec->argv[0], spec->argv, spec->envp);
  _exit(errno == ENOENT ? 127 : 126);
}

static int outcome_exit_code(int status) {
  return WIFEXITED(status) ? WEXITSTATUS(status) : 0;
}

static int outcome_signal(int status) {
  return WIFSIGNALED(status) ? WTERMSIG(status) : 0;
}

static void capsule_main(const TargetSpec *spec, int command_fd, int event_fd) {
  (void)signal(SIGTERM, SIG_IGN);
  (void)signal(SIGINT, SIG_IGN);
  (void)signal(SIGHUP, SIG_IGN);
  if (setsid() < 0) {
    send_event(event_fd, EVENT_ERROR, errno, 0, 0, 0, 0);
    _exit(1);
  }
  pid_t pgid = getpgrp();
  pid_t target = fork();
  if (target < 0) {
    send_event(event_fd, EVENT_ERROR, errno, 0, pgid, 0, 0);
    _exit(1);
  }
  if (target == 0) target_main(spec);
  close(3);
  close(4);
  close(5);
  int status = 0;
  pid_t waited;
  do {
    waited = waitpid(target, &status, WUNTRACED);
  } while (waited < 0 && errno == EINTR);
  if (waited != target || !WIFSTOPPED(status)) {
    send_event(event_fd, EVENT_ERROR, waited < 0 ? errno : ECHILD, target, pgid,
               outcome_exit_code(status), outcome_signal(status));
    _exit(1);
  }
  send_event(event_fd, EVENT_PREPARED, 0, target, pgid, 0, 0);
  CommandFrame command;
  int command_result = read_exact(command_fd, &command, sizeof(command));
  if (command_result != 1 || !command_valid(&command, COMMAND_CONFIRM)) {
    send_event(event_fd, EVENT_ERROR, command_result == 1 ? EPROTO : errno, target, pgid, 0, 0);
    (void)kill(-pgid, SIGKILL);
    _exit(1);
  }
  send_event(event_fd, EVENT_CONFIRMED, 0, target, pgid, 0, 0);
  command_result = read_exact(command_fd, &command, sizeof(command));
  if (command_result != 1 || !command_valid(&command, COMMAND_RESUME) ||
      kill(target, SIGCONT) != 0) {
    int saved = errno;
    send_event(event_fd, EVENT_ERROR,
               command_result == 1 && !command_valid(&command, COMMAND_RESUME) ? EPROTO : saved,
               target, pgid, 0, 0);
    (void)kill(-pgid, SIGKILL);
    _exit(1);
  }
  send_event(event_fd, EVENT_RESUMED, 0, target, pgid, 0, 0);
  do {
    waited = waitpid(target, &status, 0);
  } while (waited < 0 && errno == EINTR);
  if (waited == target) {
    send_event(event_fd, EVENT_EXIT, 0, target, pgid, outcome_exit_code(status), outcome_signal(status));
    _exit(0);
  }
  send_event(event_fd, EVENT_ERROR, errno, target, pgid, 0, 0);
  _exit(1);
}

static int64_t monotonic_milliseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int group_exists(pid_t pgid) {
  if (pgid <= 0) return 0;
  if (kill(-pgid, 0) == 0) return 1;
  return errno == EPERM;
}

static void begin_termination(pid_t pgid) {
  if (pgid <= 0) return;
  (void)kill(-pgid, SIGTERM);
  (void)kill(-pgid, SIGCONT);
}

static void reap_capsule_if_exited(pid_t capsule, int *reaped) {
  if (*reaped) return;
  int status = 0;
  pid_t waited;
  do {
    waited = waitpid(capsule, &status, WNOHANG);
  } while (waited < 0 && errno == EINTR);
  if (waited == capsule || (waited < 0 && errno == ECHILD)) *reaped = 1;
}

static void terminate_and_join(pid_t capsule, pid_t pgid, uint32_t grace_ms, long poll_ms) {
  int capsule_reaped = 0;
  begin_termination(pgid);
  int64_t deadline = monotonic_milliseconds() + grace_ms;
  while (group_exists(pgid) && monotonic_milliseconds() < deadline) {
    reap_capsule_if_exited(capsule, &capsule_reaped);
    (void)poll(NULL, 0, (int)poll_ms);
  }
  if (group_exists(pgid)) (void)kill(-pgid, SIGKILL);
  while (group_exists(pgid)) {
    reap_capsule_if_exited(capsule, &capsule_reaped);
    (void)poll(NULL, 0, (int)poll_ms);
  }
  if (!capsule_reaped) {
    pid_t waited;
    do {
      waited = waitpid(capsule, NULL, 0);
    } while (waited < 0 && errno == EINTR);
  }
}

static int liveness_lost(short revents) {
  return (revents & (POLLHUP | POLLERR | POLLNVAL)) != 0;
}

static int supervisor_main(const TargetSpec *spec, int main_liveness_fd, long poll_ms) {
  int commands[2];
  int events[2];
  if (pipe(commands) != 0 || pipe(events) != 0) {
    send_event(STDOUT_FILENO, EVENT_ERROR, errno, 0, 0, 0, 0);
    return 1;
  }
  pid_t capsule = fork();
  if (capsule < 0) {
    send_event(STDOUT_FILENO, EVENT_ERROR, errno, 0, 0, 0, 0);
    return 1;
  }
  if (capsule == 0) {
    close(commands[1]);
    close(events[0]);
    capsule_main(spec, commands[0], events[1]);
  }
  close(commands[0]);
  close(events[1]);

  pid_t target = 0;
  pid_t pgid = capsule;
  int target_outcome_sent = 0;
  int group_zero_sent = 0;
  int terminating = 0;
  int forced = 0;
  int64_t deadline = 0;
  int capsule_status = 0;
  int capsule_reaped = 0;
  int event_source_exhausted = 0;

  for (;;) {
    struct pollfd fds[3] = {
      { .fd = STDIN_FILENO, .events = POLLIN },
      { .fd = main_liveness_fd, .events = POLLIN },
      { .fd = events[0], .events = POLLIN },
    };
    int result = poll(fds, 3, (int)poll_ms);
    if (result < 0 && errno != EINTR) {
      send_event(STDOUT_FILENO, EVENT_ERROR, errno, target, pgid, 0, 0);
      terminate_and_join(capsule, pgid, spec->grace_ms, poll_ms);
      return 1;
    }
    if (liveness_lost(fds[0].revents) || liveness_lost(fds[1].revents)) {
      terminate_and_join(capsule, pgid, spec->grace_ms, poll_ms);
      return 0;
    }
    if ((fds[2].revents & POLLIN) != 0) {
      EventFrame event;
      int event_result = read_exact(events[0], &event, sizeof(event));
      if (event_result == 1 && event.magic == CAPSULE_MAGIC && event.version == CAPSULE_VERSION) {
        if (event.type == EVENT_PREPARED) {
          target = event.pid;
          pgid = event.pgid;
        }
        if (event.type == EVENT_EXIT) target_outcome_sent = 1;
        if (write_exact(STDOUT_FILENO, &event, sizeof(event)) != 0) {
          terminate_and_join(capsule, pgid, spec->grace_ms, poll_ms);
          return 0;
        }
      } else if (event_result != 1 && liveness_lost(fds[2].revents)) {
        close(events[0]);
        events[0] = -1;
        event_source_exhausted = 1;
      }
    } else if (liveness_lost(fds[2].revents)) {
      close(events[0]);
      events[0] = -1;
      event_source_exhausted = 1;
    }
    if ((fds[0].revents & POLLIN) != 0) {
      CommandFrame command;
      int read_result = read_exact(STDIN_FILENO, &command, sizeof(command));
      if (read_result != 1 || command.magic != CAPSULE_MAGIC || command.version != CAPSULE_VERSION) {
        terminate_and_join(capsule, pgid, spec->grace_ms, poll_ms);
        return 0;
      }
      if (command.type == COMMAND_CONFIRM || command.type == COMMAND_RESUME) {
        if (write_exact(commands[1], &command, sizeof(command)) != 0) {
          send_event(STDOUT_FILENO, EVENT_ERROR, errno, target, pgid, 0, 0);
          terminate_and_join(capsule, pgid, spec->grace_ms, poll_ms);
          return 1;
        }
      } else if (command.type == COMMAND_TERMINATE && !terminating) {
        terminating = 1;
        deadline = monotonic_milliseconds() + spec->grace_ms;
        begin_termination(pgid);
      } else if (command.type == COMMAND_RELEASE && group_zero_sent) {
        send_event(STDOUT_FILENO, EVENT_RELEASED, 0, target, pgid, 0, 0);
        return 0;
      } else {
        send_event(STDOUT_FILENO, EVENT_ERROR, EPROTO, target, pgid, 0, 0);
        terminate_and_join(capsule, pgid, spec->grace_ms, poll_ms);
        return 1;
      }
    }

    if (!capsule_reaped) {
      pid_t waited = waitpid(capsule, &capsule_status, WNOHANG);
      if (waited == capsule) capsule_reaped = 1;
    }
    if (capsule_reaped && event_source_exhausted && !target_outcome_sent && !terminating) {
      send_event(STDOUT_FILENO, EVENT_ERROR,
                 WIFEXITED(capsule_status) ? WEXITSTATUS(capsule_status) : ECHILD,
                 target, pgid, 0, WIFSIGNALED(capsule_status) ? WTERMSIG(capsule_status) : 0);
      terminate_and_join(capsule, pgid, spec->grace_ms, poll_ms);
      return 1;
    }
    if (terminating && !forced && monotonic_milliseconds() >= deadline && group_exists(pgid)) {
      forced = 1;
      (void)kill(-pgid, SIGKILL);
    }
    if (!group_zero_sent && !group_exists(pgid)) {
      /* A vanished group does not prove that the capsule's queued EXIT has been drained. */
      if (!target_outcome_sent && terminating && capsule_reaped && event_source_exhausted) {
        int synthetic_signal = forced ? SIGKILL : SIGTERM;
        send_event(STDOUT_FILENO, EVENT_EXIT, 0, target, pgid, 0, synthetic_signal);
        target_outcome_sent = 1;
      }
      if (target_outcome_sent) {
        group_zero_sent = 1;
        send_event(STDOUT_FILENO, EVENT_GROUP_ZERO, 0, target, pgid, 0, 0);
      }
    }
  }
}

int main(int argc, char **argv) {
  (void)signal(SIGPIPE, SIG_IGN);
  long main_liveness_fd = -1;
  long maximum_spec_bytes = -1;
  long poll_ms = -1;
  for (int index = 1; index < argc; index++) {
    int parsed = parse_positive_option(argv[index], "--main-liveness-fd=", &main_liveness_fd);
    if (parsed == 0) parsed = parse_positive_option(argv[index], "--max-spec-bytes=", &maximum_spec_bytes);
    if (parsed == 0) parsed = parse_positive_option(argv[index], "--poll-ms=", &poll_ms);
    if (parsed <= 0) {
      fprintf(stderr, "dsh-process-capsule: invalid argument\n");
      return 64;
    }
  }
  if (main_liveness_fd < 3 || main_liveness_fd > INT_MAX || maximum_spec_bytes < (long)sizeof(SpecHeader) ||
      poll_ms <= 0 || poll_ms > INT_MAX) {
    fprintf(stderr, "dsh-process-capsule: required bounds are missing\n");
    return 64;
  }
  TargetSpec spec = {0};
  if (read_spec((size_t)maximum_spec_bytes, &spec) != 0) {
    send_event(STDOUT_FILENO, EVENT_ERROR, EPROTO, 0, 0, 0, 0);
    return 65;
  }
  int result = supervisor_main(&spec, (int)main_liveness_fd, poll_ms);
  free_spec(&spec);
  return result;
}
