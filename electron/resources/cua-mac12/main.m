#import "cua-mac12.h"
#import <errno.h>
#import <poll.h>
#import <pthread.h>
#import <signal.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/un.h>
#import <unistd.h>

static char gSocketPath[1024];

BOOL CUAAccessibilityGranted(BOOL prompt) {
  NSDictionary *options = @{ (__bridge NSString *)kAXTrustedCheckOptionPrompt: @(prompt) };
  return AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
}

BOOL CUAScreenRecordingGranted(void) {
  return CGPreflightScreenCaptureAccess();
}

static void CUACleanupSocket(void) {
  if (gSocketPath[0]) unlink(gSocketPath);
  gSocketPath[0] = 0;
}

static void CUASignalHandler(int number) {
  CUACleanupSocket();
  _exit(0);
}

static BOOL CUAWriteAll(int fd, const uint8_t *bytes, size_t length) {
  size_t written = 0;
  while (written < length) {
    ssize_t count = write(fd, bytes + written, length - written);
    if (count < 0) {
      if (errno == EINTR) continue;
      return NO;
    }
    if (count == 0) return NO;
    written += (size_t)count;
  }
  return YES;
}

static void CUAWriteResponse(int fd, NSData *frame) {
  NSData *response = CUAHandleRPC(frame);
  if (!response) return;
  NSMutableData *line = [NSMutableData dataWithData:response];
  [line appendBytes:"\n" length:1];
  CUAWriteAll(fd, line.bytes, line.length);
}

static void CUAServeConnection(int connection) {
  NSMutableData *pending = [NSMutableData data];
  uint8_t chunk[65536];
  for (;;) {
    ssize_t count = read(connection, chunk, sizeof chunk);
    if (count < 0) {
      if (errno == EINTR) continue;
      return;
    }
    if (count == 0) return;
    [pending appendBytes:chunk length:(NSUInteger)count];
    for (;;) {
      NSRange newline = [pending rangeOfData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]
                                     options:0 range:NSMakeRange(0, pending.length)];
      if (newline.location == NSNotFound) break;
      NSData *frame = [pending subdataWithRange:NSMakeRange(0, newline.location)];
      [pending replaceBytesInRange:NSMakeRange(0, newline.location + 1) withBytes:NULL length:0];
      @autoreleasepool {
        CUAWriteResponse(connection, frame);
      }
    }
  }
}

/** One MCP client per thread: a client that stops reading (a turn that ended mid-call, a proxy left open) must not stop
 * every later client from being answered. */
static void *CUAClientThread(void *argument) {
  int connection = (int)(intptr_t)argument;
  @autoreleasepool {
    CUAServeConnection(connection);
  }
  close(connection);
  return NULL;
}

static void *CUALifelineThread(void *argument) {
  int descriptor = (int)(intptr_t)argument;
  char buffer[256];
  while (read(descriptor, buffer, sizeof buffer) > 0) {
  }
  CUACleanupSocket();
  _exit(0);
  return NULL;
}

static int CUAServe(const char *socketPath, const char *toolsPath, int lifeline) {
  NSData *data = [NSData dataWithContentsOfFile:[NSString stringWithUTF8String:toolsPath]];
  id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
  NSArray *tools = [parsed isKindOfClass:[NSDictionary class]] ? parsed[@"tools"] : nil;
  if (![tools isKindOfClass:[NSArray class]]) {
    fprintf(stderr, "cua-driver-mac12: cannot read tools from %s\n", toolsPath);
    return 2;
  }
  CUALoadTools(tools);

  if (lifeline >= 0) {
    pthread_t thread;
    if (pthread_create(&thread, NULL, CUALifelineThread, (void *)(intptr_t)lifeline) != 0) {
      fprintf(stderr, "cua-driver-mac12: cannot watch the lifeline\n");
      return 2;
    }
    pthread_detach(thread);
  }

  struct sockaddr_un address;
  memset(&address, 0, sizeof address);
  address.sun_family = AF_UNIX;
  if (strlen(socketPath) >= sizeof address.sun_path) {
    fprintf(stderr, "cua-driver-mac12: socket path is too long\n");
    return 2;
  }
  strlcpy(address.sun_path, socketPath, sizeof address.sun_path);
  strlcpy(gSocketPath, socketPath, sizeof gSocketPath);
  unlink(socketPath);

  int listener = socket(AF_UNIX, SOCK_STREAM, 0);
  if (listener < 0) {
    fprintf(stderr, "cua-driver-mac12: cannot create the socket: %s\n", strerror(errno));
    return 2;
  }
  if (bind(listener, (struct sockaddr *)&address, sizeof address) != 0) {
    fprintf(stderr, "cua-driver-mac12: cannot bind %s: %s\n", socketPath, strerror(errno));
    close(listener);
    return 2;
  }
  chmod(socketPath, 0600);
  if (listen(listener, 4) != 0) {
    fprintf(stderr, "cua-driver-mac12: cannot listen: %s\n", strerror(errno));
    CUACleanupSocket();
    close(listener);
    return 2;
  }

  for (;;) {
    int connection = accept(listener, NULL, NULL);
    if (connection < 0) {
      if (errno == EINTR) continue;
      break;
    }
    pthread_t thread;
    if (pthread_create(&thread, NULL, CUAClientThread, (void *)(intptr_t)connection) == 0) {
      pthread_detach(thread);
    } else {
      CUAServeConnection(connection);
      close(connection);
    }
  }
  CUACleanupSocket();
  close(listener);
  return 0;
}

static int CUAMcp(const char *socketPath) {
  struct sockaddr_un address;
  memset(&address, 0, sizeof address);
  address.sun_family = AF_UNIX;
  if (strlen(socketPath) >= sizeof address.sun_path) return 2;
  strlcpy(address.sun_path, socketPath, sizeof address.sun_path);

  int connection = socket(AF_UNIX, SOCK_STREAM, 0);
  if (connection < 0) return 1;
  BOOL connected = NO;
  for (int attempt = 0; attempt < 100; attempt++) {
    if (connect(connection, (struct sockaddr *)&address, sizeof address) == 0) {
      connected = YES;
      break;
    }
    usleep(50 * 1000);
  }
  if (!connected) {
    fprintf(stderr, "cua-driver-mac12: cannot connect to %s: %s\n", socketPath, strerror(errno));
    close(connection);
    return 1;
  }

  uint8_t buffer[65536];
  for (;;) {
    struct pollfd descriptors[2] = { { .fd = 0, .events = POLLIN }, { .fd = connection, .events = POLLIN } };
    int ready = poll(descriptors, 2, -1);
    if (ready < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (descriptors[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t count = read(0, buffer, sizeof buffer);
      if (count <= 0) break;
      if (!CUAWriteAll(connection, buffer, (size_t)count)) break;
    }
    if (descriptors[1].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t count = read(connection, buffer, sizeof buffer);
      if (count <= 0) break;
      if (!CUAWriteAll(1, buffer, (size_t)count)) break;
    }
  }
  close(connection);
  return 0;
}

static int CUAPermissions(BOOL prompt) {
  if (prompt) {
    CUAAccessibilityGranted(YES);
    if (!CUAScreenRecordingGranted()) CGRequestScreenCaptureAccess();
  }
  BOOL accessibility = CUAAccessibilityGranted(NO);
  BOOL screen = CUAScreenRecordingGranted();
  printf("{\"accessibility\":%s,\"screen_recording\":%s,\"screen_capture\":%s}\n",
         accessibility ? "true" : "false", screen ? "true" : "false", screen ? "true" : "false");
  fflush(stdout);
  return 0;
}

static const char *CUAOption(int argc, const char *argv[], const char *name) {
  for (int index = 2; index + 1 < argc; index++) {
    if (strcmp(argv[index], name) == 0) return argv[index + 1];
  }
  return NULL;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, CUASignalHandler);
    signal(SIGINT, CUASignalHandler);
    if (argc < 2) {
      fprintf(stderr, "usage: cua-driver-mac12 serve --socket PATH --tools PATH [--lifeline FD]\n"
                      "       cua-driver-mac12 mcp --socket PATH\n"
                      "       cua-driver-mac12 permissions status --json | request\n");
      return 2;
    }
    if (strcmp(argv[1], "serve") == 0) {
      const char *socketPath = CUAOption(argc, argv, "--socket");
      const char *toolsPath = CUAOption(argc, argv, "--tools");
      const char *lifeline = CUAOption(argc, argv, "--lifeline");
      if (!socketPath || !toolsPath) {
        fprintf(stderr, "cua-driver-mac12: serve needs --socket and --tools\n");
        return 2;
      }
      return CUAServe(socketPath, toolsPath, lifeline ? atoi(lifeline) : -1);
    }
    if (strcmp(argv[1], "mcp") == 0) {
      const char *socketPath = CUAOption(argc, argv, "--socket");
      if (!socketPath) {
        fprintf(stderr, "cua-driver-mac12: mcp needs --socket\n");
        return 2;
      }
      return CUAMcp(socketPath);
    }
    if (strcmp(argv[1], "permissions") == 0) {
      if (argc >= 3 && strcmp(argv[2], "request") == 0) return CUAPermissions(YES);
      return CUAPermissions(NO);
    }
    fprintf(stderr, "cua-driver-mac12: unknown command %s\n", argv[1]);
    return 2;
  }
}
