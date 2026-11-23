#import "cua-mac12.h"

@implementation CUAContent
@end

@implementation CUAResult
+ (instancetype)text:(NSString *)text {
  CUAResult *result = [CUAResult new];
  result.content = [NSMutableArray array];
  [result addText:text];
  return result;
}

+ (instancetype)json:(id)value {
  CUAResult *result = [CUAResult text:CUAJSONString(value)];
  if ([value isKindOfClass:[NSDictionary class]]) result.structured = value;
  return result;
}

+ (instancetype)errorText:(NSString *)text {
  CUAResult *result = [CUAResult text:text];
  result.isError = YES;
  return result;
}

- (void)addText:(NSString *)text {
  CUAContent *item = [CUAContent new];
  item.kind = @"text";
  item.text = text;
  [self.content addObject:item];
}

- (void)addImageData:(NSData *)png {
  CUAContent *item = [CUAContent new];
  item.kind = @"image";
  item.data = [png base64EncodedStringWithOptions:0];
  [self.content addObject:item];
}

- (NSDictionary *)payload {
  NSMutableArray *items = [NSMutableArray array];
  for (CUAContent *item in self.content) {
    if ([item.kind isEqualToString:@"image"]) {
      [items addObject:@{ @"type": @"image", @"data": item.data ?: @"", @"mimeType": @"image/png" }];
    } else {
      [items addObject:@{ @"type": @"text", @"text": item.text ?: @"" }];
    }
  }
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  payload[@"content"] = items;
  if (self.structured) payload[@"structuredContent"] = self.structured;
  if (self.isError) payload[@"isError"] = @YES;
  return payload;
}
@end

NSString *CUAJSONString(id value) {
  if (!value) return @"null";
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
  if (!data) return @"null";
  NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  return text ?: @"null";
}

static NSArray<NSDictionary *> *gTools = @[];
static NSString *gSession = nil;
static NSInteger gSessionCounter = 0;

void CUALoadTools(NSArray<NSDictionary *> *tools) {
  gTools = tools ?: @[];
}

NSArray<NSDictionary *> *CUATools(void) {
  return gTools;
}

static NSString *CUAEnsureSession(void) {
  if (!gSession) {
    gSession = [NSString stringWithFormat:@"mac12-%d-%ld", getpid(), (long)++gSessionCounter];
  }
  return gSession;
}

static CUAResult *CUAToolCheckPermissions(NSDictionary *args) {
  BOOL prompt = [args[@"prompt"] boolValue];
  BOOL accessibility = CUAAccessibilityGranted(prompt);
  BOOL screen = CUAScreenRecordingGranted();
  if (prompt && !screen) CGRequestScreenCaptureAccess();
  NSDictionary *structured = @{ @"accessibility": @(accessibility), @"screen_recording": @(screen) };
  NSString *text;
  if (accessibility && screen) {
    text = @"Accessibility: granted; Screen Recording: granted";
  } else {
    NSString *missing = accessibility ? @"Screen Recording" : (screen ? @"Accessibility" : @"Accessibility and Screen Recording");
    text = [NSString stringWithFormat:@"%@ required; grant access in System Settings and restart OpenMausBot", missing];
  }
  CUAResult *result = [CUAResult text:text];
  result.structured = structured;
  result.isError = !(accessibility && screen);
  return result;
}

static CUAResult *CUAToolStartSession(NSDictionary *args) {
  CUAEnsureSession();
  return [CUAResult json:@{ @"session": gSession, @"state": @"active" }];
}

static CUAResult *CUAToolEndSession(NSDictionary *args) {
  NSString *ended = gSession ?: CUAEnsureSession();
  gSession = nil;
  return [CUAResult json:@{ @"session": ended, @"state": @"ended" }];
}

static CUAResult *CUAToolGetSessionState(NSDictionary *args) {
  return [CUAResult json:@{ @"session": CUAEnsureSession(), @"state": @"active" }];
}

static CUAResult *CUAToolEscalateSession(NSDictionary *args) {
  return [CUAResult json:@{ @"session": CUAEnsureSession(), @"state": @"active" }];
}

static CUAResult *CUAToolGetAgentCursorState(NSDictionary *args) {
  return [CUAResult json:@{ @"enabled": @NO }];
}

static CUAResult *CUAToolSetAgentCursorEnabled(NSDictionary *args) {
  return [CUAResult json:@{ @"enabled": @NO }];
}

static CUAResult *CUAToolSetAgentCursorMotion(NSDictionary *args) {
  return [CUAResult json:@{ @"ok": @YES }];
}

NSDictionary *CUAHandleCall(NSString *name, NSDictionary *arguments) {
  NSDictionary *args = [arguments isKindOfClass:[NSDictionary class]] ? arguments : @{};
  CUAResult *result = nil;
  @try {
    if ([name isEqualToString:@"get_screen_size"]) result = CUAToolGetScreenSize(args);
    else if ([name isEqualToString:@"get_desktop_state"]) result = CUAToolGetDesktopState(args);
    else if ([name isEqualToString:@"list_windows"]) result = CUAToolListWindows(args);
    else if ([name isEqualToString:@"list_apps"]) result = CUAToolListApps(args);
    else if ([name isEqualToString:@"launch_app"]) result = CUAToolLaunchApp(args);
    else if ([name isEqualToString:@"zoom"]) result = CUAToolZoom(args);
    else if ([name isEqualToString:@"get_window_state"]) result = CUAToolGetWindowState(args);
    else if ([name isEqualToString:@"get_accessibility_tree"]) result = CUAToolGetAccessibilityTree(args);
    else if ([name isEqualToString:@"bring_to_front"]) result = CUAToolBringToFront(args);
    else if ([name isEqualToString:@"set_value"]) result = CUAToolSetValue(args);
    else if ([name isEqualToString:@"click"]) result = CUAToolClick(args);
    else if ([name isEqualToString:@"double_click"]) result = CUAToolDoubleClick(args);
    else if ([name isEqualToString:@"right_click"]) result = CUAToolRightClick(args);
    else if ([name isEqualToString:@"drag"]) result = CUAToolDrag(args);
    else if ([name isEqualToString:@"scroll"]) result = CUAToolScroll(args);
    else if ([name isEqualToString:@"type_text"]) result = CUAToolTypeText(args);
    else if ([name isEqualToString:@"press_key"]) result = CUAToolPressKey(args);
    else if ([name isEqualToString:@"hotkey"]) result = CUAToolHotkey(args);
    else if ([name isEqualToString:@"move_cursor"]) result = CUAToolMoveCursor(args);
    else if ([name isEqualToString:@"get_cursor_position"]) result = CUAToolGetCursorPosition(args);
    else if ([name isEqualToString:@"check_permissions"]) result = CUAToolCheckPermissions(args);
    else if ([name isEqualToString:@"start_session"]) result = CUAToolStartSession(args);
    else if ([name isEqualToString:@"end_session"]) result = CUAToolEndSession(args);
    else if ([name isEqualToString:@"get_session_state"]) result = CUAToolGetSessionState(args);
    else if ([name isEqualToString:@"escalate_session"]) result = CUAToolEscalateSession(args);
    else if ([name isEqualToString:@"get_agent_cursor_state"]) result = CUAToolGetAgentCursorState(args);
    else if ([name isEqualToString:@"set_agent_cursor_enabled"]) result = CUAToolSetAgentCursorEnabled(args);
    else if ([name isEqualToString:@"set_agent_cursor_motion"]) result = CUAToolSetAgentCursorMotion(args);
    else result = [CUAResult errorText:[NSString stringWithFormat:@"unknown tool: %@", name]];
  } @catch (NSException *exception) {
    result = [CUAResult errorText:[NSString stringWithFormat:@"%@ failed: %@", name, exception.reason ?: exception.name]];
  }
  return [result payload];
}
