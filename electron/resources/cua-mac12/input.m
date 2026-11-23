#import "cua-mac12.h"

static NSString *CUATrimmed(id value) {
  return [value isKindOfClass:[NSString class]]
    ? [[value lowercaseString] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]]
    : nil;
}

static CGEventFlags CUAFlagFor(NSString *name) {
  if ([name isEqualToString:@"cmd"] || [name isEqualToString:@"command"] || [name isEqualToString:@"meta"]) return kCGEventFlagMaskCommand;
  if ([name isEqualToString:@"shift"]) return kCGEventFlagMaskShift;
  if ([name isEqualToString:@"alt"] || [name isEqualToString:@"option"]) return kCGEventFlagMaskAlternate;
  if ([name isEqualToString:@"ctrl"] || [name isEqualToString:@"control"]) return kCGEventFlagMaskControl;
  if ([name isEqualToString:@"fn"]) return kCGEventFlagMaskSecondaryFn;
  return 0;
}

static BOOL CUAModifierKeyCode(NSString *name, CGKeyCode *code) {
  if ([name isEqualToString:@"cmd"] || [name isEqualToString:@"command"] || [name isEqualToString:@"meta"]) { *code = 55; return YES; }
  if ([name isEqualToString:@"shift"]) { *code = 56; return YES; }
  if ([name isEqualToString:@"alt"] || [name isEqualToString:@"option"]) { *code = 58; return YES; }
  if ([name isEqualToString:@"ctrl"] || [name isEqualToString:@"control"]) { *code = 59; return YES; }
  if ([name isEqualToString:@"fn"]) { *code = 63; return YES; }
  return NO;
}

static CGEventFlags CUAFlagsFor(id modifiers) {
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  if ([modifiers isKindOfClass:[NSString class]]) {
    for (NSString *part in [modifiers componentsSeparatedByString:@"+"]) [names addObject:part];
  } else if ([modifiers isKindOfClass:[NSArray class]]) {
    for (id part in modifiers) {
      if ([part isKindOfClass:[NSString class]]) {
        for (NSString *piece in [part componentsSeparatedByString:@"+"]) [names addObject:piece];
      }
    }
  }
  CGEventFlags flags = 0;
  for (NSString *name in names) {
    NSString *trimmed = CUATrimmed(name);
    if (trimmed.length) flags |= CUAFlagFor(trimmed);
  }
  return flags;
}

static void CUAPost(pid_t pid, BOOL background, CGEventRef event) {
  if (background && pid > 0) CGEventPostToPid(pid, event);
  else CGEventPost(kCGSessionEventTap, event);
}

static BOOL CUABackground(NSDictionary *args, pid_t pid) {
  NSString *mode = CUATrimmed(args[@"delivery_mode"]);
  return ![mode isEqualToString:@"foreground"] && pid > 0;
}

static void CUAPostWait(NSDictionary *args) {
  NSInteger wait = args[@"post_action_wait"] ? [args[@"post_action_wait"] integerValue] : 50;
  if (wait < 0) wait = 0;
  if (wait > 5000) wait = 5000;
  if (wait > 0) usleep((useconds_t)(wait * 1000));
}

/// A named key or single US-layout character to its virtual key code.
static BOOL CUAKeyCode(NSString *key, CGKeyCode *code) {
  static NSDictionary<NSString *, NSNumber *> *named = nil;
  static NSDictionary<NSString *, NSNumber *> *characters = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    named = @{ @"return": @36, @"enter": @76, @"tab": @48, @"space": @49, @"delete": @51,
               @"escape": @53, @"forwarddelete": @117, @"home": @115, @"end": @119,
               @"pageup": @116, @"pagedown": @121, @"left": @123, @"right": @124,
               @"down": @125, @"up": @126,
               @"f1": @122, @"f2": @120, @"f3": @99, @"f4": @118, @"f5": @96, @"f6": @97,
               @"f7": @98, @"f8": @100, @"f9": @101, @"f10": @109, @"f11": @103, @"f12": @111 };
    characters = @{ @"a": @0, @"s": @1, @"d": @2, @"f": @3, @"h": @4, @"g": @5, @"z": @6, @"x": @7,
                    @"c": @8, @"v": @9, @"b": @11, @"q": @12, @"w": @13, @"e": @14, @"r": @15,
                    @"y": @16, @"t": @17, @"1": @18, @"2": @19, @"3": @20, @"4": @21, @"6": @22,
                    @"5": @23, @"=": @24, @"9": @25, @"7": @26, @"-": @27, @"8": @28, @"0": @29,
                    @"]": @30, @"o": @31, @"u": @32, @"[": @33, @"i": @34, @"p": @35, @"l": @37,
                    @"j": @38, @"'": @39, @"k": @40, @";": @41, @"\\": @42, @",": @43, @"/": @44,
                    @"n": @45, @"m": @46, @".": @47, @"`": @50 };
  });
  NSNumber *mapped = named[key.lowercaseString] ?: characters[key.lowercaseString];
  if (!mapped) return NO;
  *code = (CGKeyCode)mapped.unsignedIntValue;
  return YES;
}

static void CUAPostUnicode(UniChar *buffer, UniCharCount length, pid_t pid, BOOL background, CGEventFlags flags) {
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, 0, true);
  CGEventKeyboardSetUnicodeString(down, length, buffer);
  CGEventSetFlags(down, flags);
  CUAPost(pid, background, down);
  CFRelease(down);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, 0, false);
  CGEventKeyboardSetUnicodeString(up, length, buffer);
  CGEventSetFlags(up, flags);
  CUAPost(pid, background, up);
  CFRelease(up);
}

static void CUAPostKeyCode(CGKeyCode code, pid_t pid, BOOL background, CGEventFlags flags) {
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, code, true);
  if (flags) CGEventSetFlags(down, flags);
  CUAPost(pid, background, down);
  CFRelease(down);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, code, false);
  if (flags) CGEventSetFlags(up, flags);
  CUAPost(pid, background, up);
  CFRelease(up);
}

static void CUAPostKey(NSString *key, pid_t pid, BOOL background, CGEventFlags flags) {
  CGKeyCode code = 0;
  if (CUAKeyCode(key, &code)) {
    CUAPostKeyCode(code, pid, background, flags);
    return;
  }
  // Anything else goes out as Unicode, so non-US layouts still receive the character.
  UniChar buffer[2];
  UniCharCount length = 0;
  [key getCharacters:buffer range:NSMakeRange(0, MIN((NSUInteger)2, key.length))];
  length = (UniCharCount)MIN((NSUInteger)2, key.length);
  if (length) CUAPostUnicode(buffer, length, pid, background, flags);
}

static void CUAMouseClick(CGPoint point, CGMouseButton button, NSInteger count,
                          CGEventFlags flags, pid_t pid, BOOL background) {
  CGEventType downType = kCGEventLeftMouseDown;
  CGEventType upType = kCGEventLeftMouseUp;
  if (button == kCGMouseButtonRight) {
    downType = kCGEventRightMouseDown;
    upType = kCGEventRightMouseUp;
  } else if (button == kCGMouseButtonCenter) {
    downType = kCGEventOtherMouseDown;
    upType = kCGEventOtherMouseUp;
  }
  for (NSInteger index = 1; index <= MAX(1, count); index++) {
    CGEventRef down = CGEventCreateMouseEvent(NULL, downType, point, button);
    CGEventSetFlags(down, flags);
    CGEventSetIntegerValueField(down, kCGMouseEventClickState, index);
    CUAPost(pid, background, down);
    CFRelease(down);
    CGEventRef up = CGEventCreateMouseEvent(NULL, upType, point, button);
    CGEventSetFlags(up, flags);
    CGEventSetIntegerValueField(up, kCGMouseEventClickState, index);
    CUAPost(pid, background, up);
    CFRelease(up);
    if (index < count) usleep(80 * 1000);
  }
}

static CGMouseButton CUAClickButton(NSDictionary *args) {
  NSString *button = CUATrimmed(args[@"button"]);
  if ([button isEqualToString:@"right"]) return kCGMouseButtonRight;
  if ([button isEqualToString:@"middle"]) return kCGMouseButtonCenter;
  return kCGMouseButtonLeft;
}

static NSString *CUANodeLabel(AXUIElementRef element) {
  id title = nil;
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXTitleAttribute, &value) == kAXErrorSuccess && value) {
    title = CFBridgingRelease(value);
  }
  id role = nil;
  value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &value) == kAXErrorSuccess && value) {
    role = CFBridgingRelease(value);
  }
  NSString *roleText = [role isKindOfClass:[NSString class]] ? role : @"element";
  if ([title isKindOfClass:[NSString class]] && [title length]) return [NSString stringWithFormat:@"%@ \"%@\"", roleText, title];
  return roleText;
}

static CUAResult *CUAClickResult(NSString *method, CGPoint point) {
  NSString *text = [method isEqualToString:@"ax"]
    ? @"clicked the element"
    : [NSString stringWithFormat:@"clicked %ld,%ld", (long)lround(point.x), (long)lround(point.y)];
  CUAResult *result = [CUAResult text:text];
  result.structured = @{ @"method": method, @"x": @(lround(point.x)), @"y": @(lround(point.y)) };
  return result;
}

static BOOL CUAHasPoint(NSDictionary *args) {
  return [args[@"x"] isKindOfClass:[NSNumber class]] && [args[@"y"] isKindOfClass:[NSNumber class]];
}

static NSString *CUAMissingTarget(NSDictionary *args) {
  return CUAHasPoint(args) ? nil : @"missing target: pass element_token or both x and y";
}

CUAResult *CUAToolClick(NSDictionary *args) {
  NSString *token = [args[@"element_token"] isKindOfClass:[NSString class]] ? args[@"element_token"] : nil;
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  BOOL background = YES;
  CGEventFlags flags = CUAFlagsFor(args[@"modifier"]);
  NSInteger count = args[@"count"] ? [args[@"count"] integerValue] : 1;
  if (count < 1) count = 1;
  if (count > 2) count = 2;
  CGMouseButton button = CUAClickButton(args);
  if (token.length) {
    AXUIElementRef element = NULL;
    pid_t owner = 0;
    if (!CUAResolveToken(token, &element, &owner)) return [CUAResult errorText:@"Unknown element_token; call get_window_state again."];
    if (pid <= 0) pid = owner;
    background = CUABackground(args, pid);
    // Read the element before acting: an AX press can close its window and invalidate it.
    NSString *label = CUANodeLabel(element);
    CGPoint center = {0, 0};
    BOOL hasCenter = CUAAXElementCenter(element, &center);
    if (button == kCGMouseButtonLeft && count == 1 &&
        AXUIElementPerformAction(element, kAXPressAction) == kAXErrorSuccess) {
      CUAPostWait(args);
      CUAResult *result = CUAClickResult(@"ax", center);
      result.content[0].text = [NSString stringWithFormat:@"clicked %@", label];
      return result;
    }
    if (!hasCenter) return [CUAResult errorText:@"element has no position or size to click"];
    CUAMouseClick(center, button, count, flags, pid, background);
    CUAPostWait(args);
    return CUAClickResult(@"mouse", center);
  }
  NSString *missing = CUAMissingTarget(args);
  if (missing) return [CUAResult errorText:missing];
  CGPoint point = CGPointMake([args[@"x"] doubleValue], [args[@"y"] doubleValue]);
  if (pid <= 0) pid = CUAFrontmostPid();
  background = CUABackground(args, pid);
  CUAMouseClick(point, button, count, flags, pid, background);
  CUAPostWait(args);
  return CUAClickResult(@"mouse", point);
}

CUAResult *CUAToolDoubleClick(NSDictionary *args) {
  NSString *token = [args[@"element_token"] isKindOfClass:[NSString class]] ? args[@"element_token"] : nil;
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  CGPoint point = {0, 0};
  if (token.length) {
    AXUIElementRef element = NULL;
    pid_t owner = 0;
    if (!CUAResolveToken(token, &element, &owner)) return [CUAResult errorText:@"Unknown element_token; call get_window_state again."];
    if (pid <= 0) pid = owner;
    if (!CUAAXElementCenter(element, &point)) return [CUAResult errorText:@"element has no position or size to click"];
  } else {
    NSString *missing = CUAMissingTarget(args);
    if (missing) return [CUAResult errorText:missing];
    point = CGPointMake([args[@"x"] doubleValue], [args[@"y"] doubleValue]);
  }
  if (pid <= 0) pid = CUAFrontmostPid();
  CUAMouseClick(point, kCGMouseButtonLeft, 2, CUAFlagsFor(args[@"modifier"]), pid, CUABackground(args, pid));
  CUAPostWait(args);
  return CUAClickResult(@"mouse", point);
}

CUAResult *CUAToolRightClick(NSDictionary *args) {
  NSString *token = [args[@"element_token"] isKindOfClass:[NSString class]] ? args[@"element_token"] : nil;
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  CGPoint point = {0, 0};
  if (token.length) {
    AXUIElementRef element = NULL;
    pid_t owner = 0;
    if (!CUAResolveToken(token, &element, &owner)) return [CUAResult errorText:@"Unknown element_token; call get_window_state again."];
    if (pid <= 0) pid = owner;
    NSString *label = CUANodeLabel(element);
    CGPoint center = {0, 0};
    BOOL hasCenter = CUAAXElementCenter(element, &center);
    if (CUAAXHasAction(element, kAXShowMenuAction) &&
        AXUIElementPerformAction(element, kAXShowMenuAction) == kAXErrorSuccess) {
      CUAPostWait(args);
      CUAResult *result = CUAClickResult(@"ax", center);
      result.content[0].text = [NSString stringWithFormat:@"right-clicked %@", label];
      return result;
    }
    if (!hasCenter) return [CUAResult errorText:@"element has no position or size to click"];
    point = center;
  } else {
    NSString *missing = CUAMissingTarget(args);
    if (missing) return [CUAResult errorText:missing];
    point = CGPointMake([args[@"x"] doubleValue], [args[@"y"] doubleValue]);
  }
  if (pid <= 0) pid = CUAFrontmostPid();
  CUAMouseClick(point, kCGMouseButtonRight, 1, CUAFlagsFor(args[@"modifier"]), pid, CUABackground(args, pid));
  CUAPostWait(args);
  return CUAClickResult(@"mouse", point);
}

CUAResult *CUAToolDrag(NSDictionary *args) {
  for (NSString *key in @[ @"from_x", @"from_y", @"to_x", @"to_y" ]) {
    if (!args[key]) return [CUAResult errorText:[NSString stringWithFormat:@"drag needs %@", key]];
  }
  NSInteger steps = args[@"steps"] ? [args[@"steps"] integerValue] : 10;
  if (steps < 1) steps = 1;
  if (steps > 200) steps = 200;
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  if (pid <= 0) pid = CUAFrontmostPid();
  BOOL background = CUABackground(args, pid);
  CGEventFlags flags = CUAFlagsFor(args[@"modifier"]);
  CGPoint from = CGPointMake([args[@"from_x"] doubleValue], [args[@"from_y"] doubleValue]);
  CGPoint to = CGPointMake([args[@"to_x"] doubleValue], [args[@"to_y"] doubleValue]);
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, from, kCGMouseButtonLeft);
  CGEventSetFlags(down, flags);
  CUAPost(pid, background, down);
  CFRelease(down);
  for (NSInteger step = 1; step <= steps; step++) {
    double ratio = (double)step / (double)steps;
    CGPoint point = CGPointMake(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio);
    CGEventRef dragged = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDragged, point, kCGMouseButtonLeft);
    CGEventSetFlags(dragged, flags);
    CUAPost(pid, background, dragged);
    CFRelease(dragged);
    usleep(10 * 1000);
  }
  CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, to, kCGMouseButtonLeft);
  CGEventSetFlags(up, flags);
  CUAPost(pid, background, up);
  CFRelease(up);
  CUAPostWait(args);
  CUAResult *result = [CUAResult text:[NSString stringWithFormat:@"dragged %ld,%ld to %ld,%ld",
                                                                  (long)lround(from.x), (long)lround(from.y),
                                                                  (long)lround(to.x), (long)lround(to.y)]];
  result.structured = @{ @"from_x": @(lround(from.x)), @"from_y": @(lround(from.y)),
                         @"to_x": @(lround(to.x)), @"to_y": @(lround(to.y)) };
  return result;
}

CUAResult *CUAToolScroll(NSDictionary *args) {
  NSString *direction = CUATrimmed(args[@"direction"]) ?: @"";
  if (![@[ @"up", @"down", @"left", @"right" ] containsObject:direction]) {
    return [CUAResult errorText:@"scroll needs direction: up, down, left or right"];
  }
  NSInteger amount = args[@"amount"] ? [args[@"amount"] integerValue] : 3;
  if (amount < 1) amount = 1;
  if (amount > 50) amount = 50;
  BOOL pages = [CUATrimmed(args[@"by"]) isEqualToString:@"page"];
  int32_t lines = (int32_t)(pages ? amount * 10 : amount);
  CGEventRef cursor = CGEventCreate(NULL);
  CGPoint point = cursor ? CGEventGetLocation(cursor) : CGPointMake(0, 0);
  if (cursor) CFRelease(cursor);
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  NSString *token = [args[@"element_token"] isKindOfClass:[NSString class]] ? args[@"element_token"] : nil;
  if (token.length) {
    AXUIElementRef element = NULL;
    pid_t owner = 0;
    if (!CUAResolveToken(token, &element, &owner)) return [CUAResult errorText:@"Unknown element_token; call get_window_state again."];
    if (pid <= 0) pid = owner;
    CGPoint center = {0, 0};
    if (CUAAXElementCenter(element, &center)) point = center;
  }
  if (args[@"x"] && args[@"y"]) point = CGPointMake([args[@"x"] doubleValue], [args[@"y"] doubleValue]);
  if (pid <= 0) pid = CUAFrontmostPid();
  int32_t vertical = 0;
  int32_t horizontal = 0;
  if ([direction isEqualToString:@"up"]) vertical = lines;
  else if ([direction isEqualToString:@"down"]) vertical = -lines;
  else if ([direction isEqualToString:@"left"]) horizontal = -lines;
  else horizontal = lines;
  CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point, kCGMouseButtonLeft);
  BOOL background = CUABackground(args, pid);
  CUAPost(pid, background, move);
  CFRelease(move);
  CGEventRef event = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, vertical, horizontal);
  CUAPost(pid, background, event);
  CFRelease(event);
  CUAPostWait(args);
  return [CUAResult text:[NSString stringWithFormat:@"scrolled %@ %ld %@",
                                                    direction, (long)amount, pages ? @"pages" : @"lines"]];
}

CUAResult *CUAToolTypeText(NSDictionary *args) {
  NSString *text = [args[@"text"] isKindOfClass:[NSString class]] ? args[@"text"] : nil;
  if (!text.length) return [CUAResult errorText:@"type_text needs text"];
  if (text.length > 10000) return [CUAResult errorText:@"type_text: text is longer than 10000 characters"];
  NSInteger delayMs = args[@"delay_ms"] ? [args[@"delay_ms"] integerValue] : 15;
  if (delayMs < 0) delayMs = 0;
  if (delayMs > 200) delayMs = 200;
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  NSString *token = [args[@"element_token"] isKindOfClass:[NSString class]] ? args[@"element_token"] : nil;
  if (token.length) {
    AXUIElementRef element = NULL;
    pid_t owner = 0;
    if (!CUAResolveToken(token, &element, &owner)) return [CUAResult errorText:@"Unknown element_token; call get_window_state again."];
    if (pid <= 0) pid = owner;
    CUAAXFocus(element);
  }
  BOOL background = CUABackground(args, pid);
  if (pid <= 0) pid = CUAFrontmostPid();
  NSInteger typed = 0;
  for (NSUInteger index = 0; index < text.length; index++) {
    unichar character = [text characterAtIndex:index];
    if (character == '\n') {
      CUAPostKeyCode(36, pid, background, 0);
    } else if (character == '\t') {
      CUAPostKeyCode(48, pid, background, 0);
    } else {
      UniChar buffer[2] = { character, 0 };
      UniCharCount length = 1;
      if (CFStringIsSurrogateHighCharacter(character) && index + 1 < text.length &&
          CFStringIsSurrogateLowCharacter([text characterAtIndex:index + 1])) {
        buffer[1] = [text characterAtIndex:index + 1];
        length = 2;
        index++;
      }
      CUAPostUnicode(buffer, length, pid, background, 0);
    }
    typed++;
    if (delayMs > 0 && index + 1 < text.length) usleep((useconds_t)(delayMs * 1000));
  }
  CUAPostWait(args);
  return [CUAResult text:[NSString stringWithFormat:@"typed %ld characters", (long)typed]];
}

CUAResult *CUAToolPressKey(NSDictionary *args) {
  NSString *key = [args[@"key"] isKindOfClass:[NSString class]] ? args[@"key"] : nil;
  if (!key.length) return [CUAResult errorText:@"press_key needs key"];
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  NSString *token = [args[@"element_token"] isKindOfClass:[NSString class]] ? args[@"element_token"] : nil;
  if (token.length) {
    AXUIElementRef element = NULL;
    pid_t owner = 0;
    if (!CUAResolveToken(token, &element, &owner)) return [CUAResult errorText:@"Unknown element_token; call get_window_state again."];
    if (pid <= 0) pid = owner;
    CUAAXFocus(element);
  }
  if (pid <= 0) pid = CUAFrontmostPid();
  CUAPostKey(key, pid, CUABackground(args, pid), CUAFlagsFor(args[@"modifiers"]));
  CUAPostWait(args);
  return [CUAResult text:[NSString stringWithFormat:@"pressed %@", key]];
}

CUAResult *CUAToolHotkey(NSDictionary *args) {
  NSArray *keys = [args[@"keys"] isKindOfClass:[NSArray class]] ? args[@"keys"] : nil;
  if (!keys.count) return [CUAResult errorText:@"hotkey needs keys"];
  NSMutableArray<NSString *> *names = [NSMutableArray array];
  for (id key in keys) {
    if (![key isKindOfClass:[NSString class]]) return [CUAResult errorText:@"hotkey: every key must be a string"];
    NSString *name = CUATrimmed(key);
    if (!name.length) return [CUAResult errorText:@"hotkey: empty key"];
    [names addObject:name];
  }
  NSString *main = names.lastObject;
  CGEventFlags flags = 0;
  NSMutableArray<NSNumber *> *modifierCodes = [NSMutableArray array];
  for (NSUInteger index = 0; index + 1 < names.count; index++) {
    CGKeyCode code = 0;
    if (!CUAModifierKeyCode(names[index], &code)) {
      return [CUAResult errorText:[NSString stringWithFormat:@"hotkey: %@ is not a modifier", names[index]]];
    }
    flags |= CUAFlagFor(names[index]);
    [modifierCodes addObject:@(code)];
  }
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  NSString *token = [args[@"element_token"] isKindOfClass:[NSString class]] ? args[@"element_token"] : nil;
  if (token.length) {
    AXUIElementRef element = NULL;
    pid_t owner = 0;
    if (!CUAResolveToken(token, &element, &owner)) return [CUAResult errorText:@"Unknown element_token; call get_window_state again."];
    if (pid <= 0) pid = owner;
    CUAAXFocus(element);
  }
  if (pid <= 0) pid = CUAFrontmostPid();
  BOOL background = CUABackground(args, pid);
  for (NSNumber *code in modifierCodes) {
    CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code.unsignedIntValue, true);
    CGEventSetFlags(down, flags);
    CUAPost(pid, background, down);
    CFRelease(down);
  }
  CUAPostKey(main, pid, background, flags);
  for (NSNumber *code in [modifierCodes reverseObjectEnumerator]) {
    CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)code.unsignedIntValue, false);
    CGEventSetFlags(up, flags);
    CUAPost(pid, background, up);
    CFRelease(up);
  }
  CUAPostWait(args);
  return [CUAResult text:[NSString stringWithFormat:@"pressed %@", [names componentsJoinedByString:@"+"]]];
}

CUAResult *CUAToolMoveCursor(NSDictionary *args) {
  if (!args[@"x"] || !args[@"y"]) return [CUAResult errorText:@"move_cursor needs x and y"];
  CGPoint point = CGPointMake([args[@"x"] doubleValue], [args[@"y"] doubleValue]);
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  BOOL background = CUABackground(args, pid);
  if (background) {
    CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point, kCGMouseButtonLeft);
    CGEventPostToPid(pid, move);
    CFRelease(move);
  } else {
    CGWarpMouseCursorPosition(point);
  }
  return [CUAResult text:[NSString stringWithFormat:@"moved the cursor to %ld,%ld", (long)lround(point.x), (long)lround(point.y)]];
}

CUAResult *CUAToolGetCursorPosition(NSDictionary *args) {
  CGEventRef event = CGEventCreate(NULL);
  CGPoint point = event ? CGEventGetLocation(event) : CGPointZero;
  if (event) CFRelease(event);
  return [CUAResult json:@{ @"x": @(lround(point.x)), @"y": @(lround(point.y)) }];
}
