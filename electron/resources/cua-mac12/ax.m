#import "cua-mac12.h"
#import <AppKit/AppKit.h>

static AXUIElementRef *gStore = NULL;
static NSInteger gStoreCount = 0;
static NSInteger gStoreCapacity = 0;

void CUAStoreReset(void) {
  for (NSInteger index = 0; index < gStoreCount; index++) CFRelease(gStore[index]);
  gStoreCount = 0;
}

NSString *CUAStoreAdd(pid_t pid, AXUIElementRef element) {
  if (gStoreCount == gStoreCapacity) {
    gStoreCapacity = gStoreCapacity ? gStoreCapacity * 2 : 128;
    gStore = realloc(gStore, sizeof(AXUIElementRef) * (size_t)gStoreCapacity);
  }
  CFRetain(element);
  gStore[gStoreCount++] = element;
  return [NSString stringWithFormat:@"ax:%d:%ld", pid, (long)gStoreCount];
}

AXUIElementRef CUAStoreResolve(NSString *token) {
  if (![token isKindOfClass:[NSString class]]) return NULL;
  NSArray<NSString *> *parts = [token componentsSeparatedByString:@":"];
  if (parts.count != 3 || ![parts[0] isEqualToString:@"ax"]) return NULL;
  NSInteger serial = parts[2].integerValue;
  if (serial < 1 || serial > gStoreCount) return NULL;
  AXUIElementRef element = gStore[serial - 1];
  pid_t actual = 0;
  if (AXUIElementGetPid(element, &actual) != kAXErrorSuccess) return NULL;
  if (actual != (pid_t)parts[1].intValue) return NULL;
  return element;
}

BOOL CUAResolveToken(NSString *token, AXUIElementRef *element, pid_t *pid) {
  AXUIElementRef resolved = CUAStoreResolve(token);
  if (!resolved) return NO;
  if (element) *element = resolved;
  if (pid) {
    pid_t actual = 0;
    AXUIElementGetPid(resolved, &actual);
    *pid = actual;
  }
  return YES;
}

static id AXCopy(AXUIElementRef element, CFStringRef attribute) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, attribute, &value) != kAXErrorSuccess || !value) return nil;
  return CFBridgingRelease(value);
}

static BOOL AXPoint(AXUIElementRef element, CGPoint *point) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &value) != kAXErrorSuccess || !value) return NO;
  BOOL ok = NO;
  if (CFGetTypeID(value) == AXValueGetTypeID()) ok = AXValueGetValue((AXValueRef)value, kAXValueCGPointType, point);
  CFRelease(value);
  return ok;
}

static BOOL AXSize(AXUIElementRef element, CGSize *size) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &value) != kAXErrorSuccess || !value) return NO;
  BOOL ok = NO;
  if (CFGetTypeID(value) == AXValueGetTypeID()) ok = AXValueGetValue((AXValueRef)value, kAXValueCGSizeType, size);
  CFRelease(value);
  return ok;
}

BOOL CUAAXElementCenter(AXUIElementRef element, CGPoint *center) {
  CGPoint position = {0, 0};
  CGSize size = {0, 0};
  if (!AXPoint(element, &position) || !AXSize(element, &size)) return NO;
  center->x = position.x + size.width / 2;
  center->y = position.y + size.height / 2;
  return YES;
}

BOOL CUAAXHasAction(AXUIElementRef element, CFStringRef action) {
  CFArrayRef names = NULL;
  if (AXUIElementCopyActionNames(element, &names) != kAXErrorSuccess || !names) return NO;
  BOOL found = [(__bridge NSArray *)names containsObject:(__bridge NSString *)action];
  CFRelease(names);
  return found;
}

void CUAAXFocus(AXUIElementRef element) {
  AXUIElementSetAttributeValue(element, kAXFocusedAttribute, kCFBooleanTrue);
}

pid_t CUAFrontmostPid(void) {
  return [NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier;
}

NSString *CUAFrontmostAppName(void) {
  return [NSWorkspace sharedWorkspace].frontmostApplication.localizedName;
}

/// The app element and its target window, both owned by the caller.
BOOL CUAAXWindowFor(pid_t pid, NSInteger windowID, AXUIElementRef *appOut, AXUIElementRef *windowOut) {
  if (pid <= 0) return NO;
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app) return NO;
  NSArray *windows = AXCopy(app, kAXWindowsAttribute);
  if (![windows isKindOfClass:[NSArray class]] || windows.count == 0) {
    CFRelease(app);
    return NO;
  }
  AXUIElementRef chosen = NULL;
  BOOL sawNumber = NO;
  for (id entry in windows) {
    AXUIElementRef window = (__bridge AXUIElementRef)entry;
    NSNumber *number = AXCopy(window, CFSTR("AXWindowNumber"));
    if (![number isKindOfClass:[NSNumber class]]) number = nil;
    if (number) sawNumber = YES;
    if (windowID <= 0) {
      chosen = window;
      break;
    }
    if (number && number.integerValue == windowID) {
      chosen = window;
      break;
    }
  }
  if (!chosen && windowID > 0 && !sawNumber) chosen = (__bridge AXUIElementRef)windows[0];
  if (!chosen) {
    CFRelease(app);
    return NO;
  }
  CFRetain(chosen);
  if (appOut) *appOut = app;
  else CFRelease(app);
  if (windowOut) *windowOut = chosen;
  else CFRelease(chosen);
  return YES;
}

static NSInteger CUAWindowNumberOf(AXUIElementRef window) {
  NSNumber *number = AXCopy(window, CFSTR("AXWindowNumber"));
  return [number isKindOfClass:[NSNumber class]] ? number.integerValue : 0;
}

@interface CUANode : NSObject
@property (nonatomic) NSInteger parent;
@property (nonatomic) NSInteger depth;
@property (nonatomic, copy) NSString *role;
@property (nonatomic, copy) NSString *subrole;
@property (nonatomic, copy) NSString *title;
@property (nonatomic, copy) NSString *desc;
@property (nonatomic, copy) NSString *value;
@property (nonatomic, copy) NSString *identifier;
@property (nonatomic) BOOL hasFrame;
@property (nonatomic) CGRect frame;
@property (nonatomic) BOOL enabled;
@property (nonatomic) BOOL focused;
@property (nonatomic, copy) NSArray<NSString *> *actions;
@property (nonatomic, copy) NSString *token;
@property (nonatomic) BOOL ancestorOnly;
@end

@implementation CUANode
@end

typedef struct {
  NSInteger maxDepth;
  NSInteger maxElements;
  BOOL fullOutput;
  BOOL timedOut;
  BOOL truncated;
  CFAbsoluteTime deadline;
} CUAWalkOptions;

static NSString *CUAScalarText(id value, BOOL fullOutput) {
  NSString *text = nil;
  if ([value isKindOfClass:[NSString class]]) text = value;
  else if ([value isKindOfClass:[NSNumber class]]) {
    if (CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) text = [value boolValue] ? @"true" : @"false";
    else text = [value stringValue];
  }
  if (!text) return nil;
  if (!fullOutput && text.length > 200) text = [[text substringToIndex:200] stringByAppendingString:@"…"];
  return text;
}

static CUANode *CUANodeFor(AXUIElementRef element, NSInteger parent, NSInteger depth, pid_t pid, BOOL fullOutput) {
  CUANode *node = [CUANode new];
  node.parent = parent;
  node.depth = depth;
  node.token = CUAStoreAdd(pid, element);
  NSString *role = AXCopy(element, kAXRoleAttribute);
  node.role = [role isKindOfClass:[NSString class]] ? role : @"AXUnknown";
  NSString *subrole = AXCopy(element, kAXSubroleAttribute);
  node.subrole = [subrole isKindOfClass:[NSString class]] ? subrole : nil;
  NSString *title = AXCopy(element, kAXTitleAttribute);
  node.title = [title isKindOfClass:[NSString class]] ? title : nil;
  NSString *desc = AXCopy(element, kAXDescriptionAttribute);
  node.desc = [desc isKindOfClass:[NSString class]] ? desc : nil;
  NSString *identifier = AXCopy(element, kAXIdentifierAttribute);
  node.identifier = [identifier isKindOfClass:[NSString class]] ? identifier : nil;
  if ([node.role isEqualToString:@"AXSecureTextField"]) {
    node.value = @"<redacted>";
  } else {
    node.value = CUAScalarText(AXCopy(element, kAXValueAttribute), fullOutput);
  }
  CGPoint position = {0, 0};
  CGSize size = {0, 0};
  if (AXPoint(element, &position) && AXSize(element, &size)) {
    node.hasFrame = YES;
    node.frame = CGRectMake(position.x, position.y, size.width, size.height);
  }
  NSNumber *enabled = AXCopy(element, kAXEnabledAttribute);
  node.enabled = [enabled isKindOfClass:[NSNumber class]] ? enabled.boolValue : YES;
  NSNumber *focused = AXCopy(element, kAXFocusedAttribute);
  node.focused = [focused isKindOfClass:[NSNumber class]] ? focused.boolValue : NO;
  CFArrayRef actions = NULL;
  if (AXUIElementCopyActionNames(element, &actions) == kAXErrorSuccess && actions) {
    node.actions = (__bridge_transfer NSArray *)actions;
  }
  return node;
}

static void CUAWalk(AXUIElementRef element, NSInteger parent, NSInteger depth, pid_t pid,
                    CUAWalkOptions *options, NSMutableArray<CUANode *> *nodes) {
  if (options->timedOut || options->truncated) return;
  if (CFAbsoluteTimeGetCurrent() > options->deadline) {
    options->timedOut = YES;
    return;
  }
  if ((NSInteger)nodes.count >= options->maxElements) {
    options->truncated = YES;
    return;
  }
  CUANode *node = CUANodeFor(element, parent, depth, pid, options->fullOutput);
  [nodes addObject:node];
  if (depth >= options->maxDepth) return;
  NSArray *children = AXCopy(element, kAXChildrenAttribute);
  if (![children isKindOfClass:[NSArray class]]) return;
  NSInteger index = (NSInteger)nodes.count - 1;
  for (id child in children) {
    CUAWalk((__bridge AXUIElementRef)child, index, depth + 1, pid, options, nodes);
    if (options->timedOut || options->truncated) return;
  }
}

static BOOL CUANodeMatches(CUANode *node, NSString *query) {
  for (NSString *field in @[ node.role ?: @"", node.title ?: @"", node.desc ?: @"", node.value ?: @"" ]) {
    if ([field rangeOfString:query options:NSCaseInsensitiveSearch].location != NSNotFound) return YES;
  }
  return NO;
}

/// Keeps matching nodes and their ancestors; ancestors are flagged so they print without a token.
static void CUAFilterForQuery(NSMutableArray<CUANode *> *nodes, NSString *query) {
  NSMutableIndexSet *keep = [NSMutableIndexSet indexSet];
  for (NSInteger index = 0; index < (NSInteger)nodes.count; index++) {
    if (!CUANodeMatches(nodes[index], query)) continue;
    [keep addIndex:(NSUInteger)index];
    nodes[index].ancestorOnly = NO;
    NSInteger parent = nodes[index].parent;
    while (parent >= 0 && ![keep containsIndex:(NSUInteger)parent]) {
      [keep addIndex:(NSUInteger)parent];
      nodes[parent].ancestorOnly = YES;
      parent = nodes[parent].parent;
    }
  }
  for (NSInteger index = (NSInteger)nodes.count - 1; index >= 0; index--) {
    if (![keep containsIndex:(NSUInteger)index]) [nodes removeObjectAtIndex:(NSUInteger)index];
  }
}

static NSString *CUAEscape(NSString *text) {
  NSString *escaped = [text stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"];
  escaped = [escaped stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
  escaped = [escaped stringByReplacingOccurrencesOfString:@"\n" withString:@"\\n"];
  escaped = [escaped stringByReplacingOccurrencesOfString:@"\r" withString:@"\\r"];
  return [escaped stringByReplacingOccurrencesOfString:@"\t" withString:@"\\t"];
}

static NSString *CUARenderText(NSArray<CUANode *> *nodes, NSString *header,
                               CUAWalkOptions options, BOOL queryFiltered) {
  NSMutableString *text = [NSMutableString string];
  if (header.length) [text appendFormat:@"%@\n", header];
  for (CUANode *node in nodes) {
    NSMutableString *line = [NSMutableString string];
    for (NSInteger depth = 0; depth < node.depth; depth++) [line appendString:@"  "];
    if (node.token.length && !node.ancestorOnly) [line appendFormat:@"[%@] ", node.token];
    [line appendString:node.role];
    if (node.subrole.length) [line appendFormat:@" %@", node.subrole];
    if (node.title.length) [line appendFormat:@" \"%@\"", CUAEscape(node.title)];
    if (node.desc.length) [line appendFormat:@" desc=\"%@\"", CUAEscape(node.desc)];
    if (node.value.length) [line appendFormat:@" value=\"%@\"", CUAEscape(node.value)];
    if (node.identifier.length) [line appendFormat:@" id=\"%@\"", CUAEscape(node.identifier)];
    if (node.hasFrame) {
      [line appendFormat:@" pos=%ld,%ld size=%ldx%ld",
        (long)lround(node.frame.origin.x), (long)lround(node.frame.origin.y),
        (long)lround(node.frame.size.width), (long)lround(node.frame.size.height)];
    }
    if (!node.enabled) [line appendString:@" enabled=false"];
    if (node.focused) [line appendString:@" focused"];
    if (node.actions.count) [line appendFormat:@" actions=%@", [node.actions componentsJoinedByString:@","]];
    [text appendFormat:@"%@\n", line];
  }
  if (options.timedOut) [text appendString:@"… (truncated: accessibility tree timed out)\n"];
  else if (options.truncated) [text appendString:@"… (truncated: element limit reached)\n"];
  if (queryFiltered && nodes.count == 0) [text appendString:@"no elements matched the query\n"];
  return text;
}

static NSArray<NSDictionary *> *CUARenderJSON(NSArray<CUANode *> *nodes, NSString *header) {
  NSMutableArray *items = [NSMutableArray array];
  if (header.length) [items addObject:@{ @"header": header }];
  for (CUANode *node in nodes) {
    NSMutableDictionary *item = [NSMutableDictionary dictionary];
    item[@"depth"] = @(node.depth);
    item[@"role"] = node.role;
    if (node.subrole.length) item[@"subrole"] = node.subrole;
    if (node.title.length) item[@"title"] = node.title;
    if (node.desc.length) item[@"description"] = node.desc;
    if (node.value.length) item[@"value"] = node.value;
    if (node.identifier.length) item[@"identifier"] = node.identifier;
    if (node.hasFrame) {
      item[@"x"] = @(node.frame.origin.x);
      item[@"y"] = @(node.frame.origin.y);
      item[@"width"] = @(node.frame.size.width);
      item[@"height"] = @(node.frame.size.height);
    }
    item[@"enabled"] = @(node.enabled);
    item[@"focused"] = @(node.focused);
    item[@"actions"] = node.actions ?: @[];
    if (node.token.length && !node.ancestorOnly) item[@"token"] = node.token;
    [items addObject:item];
  }
  return items;
}

static NSInteger CUALimit(NSDictionary *args, NSString *key, NSInteger fallback, NSInteger cap) {
  NSInteger value = args[key] ? [args[key] integerValue] : fallback;
  if (value < 1) value = 1;
  if (value > cap) value = cap;
  return value;
}

static BOOL CUABoolArg(NSDictionary *args, NSString *key, BOOL fallback) {
  id value = args[key];
  return [value isKindOfClass:[NSNumber class]] ? [value boolValue] : fallback;
}

static NSString *CUATreeHeader(AXUIElementRef window, pid_t pid, CGWindowID windowID, NSString *appName) {
  NSString *title = AXCopy(window, kAXTitleAttribute);
  if (![title isKindOfClass:[NSString class]]) title = @"";
  return [NSString stringWithFormat:@"window %u \"%@\" app \"%@\" pid %d",
                                    (unsigned)windowID, title, appName ?: @"", pid];
}

static void CUATreeArguments(NSDictionary *args, CUAWalkOptions *options) {
  options->maxDepth = CUALimit(args, @"max_depth", 8, 20);
  options->maxElements = CUALimit(args, @"max_elements", 200, 500);
  options->fullOutput = CUABoolArg(args, @"full_output", NO);
  options->timedOut = NO;
  options->truncated = NO;
  options->deadline = CFAbsoluteTimeGetCurrent() + 3.0;
}

static void CUASetAXTimeout(void) {
  AXUIElementRef systemWide = AXUIElementCreateSystemWide();
  if (!systemWide) return;
  AXUIElementSetMessagingTimeout(systemWide, 0.5);
  CFRelease(systemWide);
}

CUAResult *CUAToolGetAccessibilityTree(NSDictionary *args) {
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  if (pid <= 0) pid = CUAFrontmostPid();
  if (pid <= 0) return [CUAResult errorText:@"no frontmost application"];
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app) return [CUAResult errorText:[NSString stringWithFormat:@"no accessibility application for pid %d", pid]];
  CUASetAXTimeout();
  CUAStoreReset();
  CUAWalkOptions options;
  CUATreeArguments(args, &options);
  NSMutableArray<CUANode *> *nodes = [NSMutableArray array];
  CUAWalk(app, -1, 0, pid, &options, nodes);
  CFRelease(app);
  NSString *query = [args[@"query"] isKindOfClass:[NSString class]] ? args[@"query"] : nil;
  if (query.length) CUAFilterForQuery(nodes, query);
  NSString *appName = [NSRunningApplication runningApplicationWithProcessIdentifier:pid].localizedName ?: @"";
  NSString *header = [NSString stringWithFormat:@"app \"%@\" pid %d", appName, pid];
  NSString *format = [args[@"tree_format"] isKindOfClass:[NSString class]] ? args[@"tree_format"] : @"";
  if ([format isEqualToString:@"json"]) {
    return [CUAResult text:CUAJSONString(CUARenderJSON(nodes, header))];
  }
  return [CUAResult text:CUARenderText(nodes, header, options, query.length > 0)];
}

CUAResult *CUAToolGetWindowState(NSDictionary *args) {
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  if (pid <= 0) pid = CUAFrontmostPid();
  NSInteger requestedWindow = [args[@"window_id"] integerValue];
  NSString *captureMode = [args[@"capture_mode"] isKindOfClass:[NSString class]] ? args[@"capture_mode"] : nil;
  BOOL includeTree = CUABoolArg(args, @"include_accessibility_tree", ![captureMode isEqualToString:@"vision"]);
  BOOL includeScreenshot = CUABoolArg(args, @"include_screenshot", ![captureMode isEqualToString:@"ax"]);
  if (!includeTree && !includeScreenshot) return [CUAResult errorText:@"get_window_state: nothing requested"];
  NSString *treeFormat = [args[@"tree_format"] isKindOfClass:[NSString class]] ? args[@"tree_format"] : nil;
  NSString *outFile = [args[@"screenshot_out_file"] isKindOfClass:[NSString class]] ? args[@"screenshot_out_file"] : nil;

  AXUIElementRef app = NULL;
  AXUIElementRef window = NULL;
  BOOL hasWindow = pid > 0 && CUAAXWindowFor(pid, requestedWindow, &app, &window);
  CGWindowID windowID = (CGWindowID)requestedWindow;
  if (hasWindow) {
    NSInteger number = CUAWindowNumberOf(window);
    if (number > 0) windowID = (CGWindowID)number;
  }
  if (windowID == kCGNullWindowID) windowID = CUAFrontWindowID(pid);
  NSString *appName = [NSRunningApplication runningApplicationWithProcessIdentifier:pid].localizedName;
  if (!appName.length && windowID != kCGNullWindowID) appName = @"application";

  NSData *png = nil;
  CUASize full = {0, 0};
  CUASize returned = {0, 0};
  if (includeScreenshot) {
    if (!CUAScreenRecordingGranted()) {
      if (hasWindow) { CFRelease(window); CFRelease(app); }
      return [CUAResult errorText:@"Screen Recording required"];
    }
    if (windowID == kCGNullWindowID) {
      if (hasWindow) { CFRelease(window); CFRelease(app); }
      return [CUAResult errorText:@"get_window_state: no window to capture"];
    }
    CGImageRef image = CUACaptureWindow(windowID);
    if (!image) {
      if (hasWindow) { CFRelease(window); CFRelease(app); }
      return [CUAResult errorText:@"window capture failed"];
    }
    png = CUAPNGForImage(image, CUAMaxImageDimension(args), &full, &returned);
    CGImageRelease(image);
    if (!png) {
      if (hasWindow) { CFRelease(window); CFRelease(app); }
      return [CUAResult errorText:@"could not encode the screenshot as PNG"];
    }
  }

  NSString *treeText = nil;
  BOOL jsonTree = NO;
  if (includeTree) {
    CUASetAXTimeout();
    CUAStoreReset();
    CUAWalkOptions options;
    CUATreeArguments(args, &options);
    NSMutableArray<CUANode *> *nodes = [NSMutableArray array];
    if (hasWindow) {
      NSString *header = CUATreeHeader(window, pid, windowID, appName);
      CUAWalk(window, -1, 0, pid, &options, nodes);
      NSString *query = [args[@"query"] isKindOfClass:[NSString class]] ? args[@"query"] : nil;
      if (query.length) CUAFilterForQuery(nodes, query);
      jsonTree = [treeFormat isEqualToString:@"json"];
      treeText = jsonTree ? CUAJSONString(CUARenderJSON(nodes, header))
                          : CUARenderText(nodes, header, options, query.length > 0);
    } else {
      treeText = @"no accessibility window\n";
    }
  }
  if (hasWindow) { CFRelease(window); CFRelease(app); }

  NSString *sizeLine = includeScreenshot
    ? [NSString stringWithFormat:@"image: %ldx%ld returned: %ldx%ld",
                                 (long)full.width, (long)full.height, (long)returned.width, (long)returned.height]
    : nil;
  CUAResult *result = nil;
  if (sizeLine && jsonTree) {
    // Keeping the array parseable: the size line is its own item rather than a prefix line.
    result = [CUAResult text:sizeLine];
    [result addText:treeText];
  } else {
    NSMutableString *text = [NSMutableString string];
    if (sizeLine) [text appendFormat:@"%@\n", sizeLine];
    if (treeText) [text appendString:treeText];
    result = [CUAResult text:text];
  }
  if (png) {
    if (outFile.length) {
      NSString *errorText = nil;
      if (!CUAWritePNG(png, outFile, &errorText)) return [CUAResult errorText:errorText ?: @"could not write screenshot_out_file"];
      [result addText:[NSString stringWithFormat:@"screenshot written to %@", outFile]];
    } else {
      [result addImageData:png];
    }
  }
  return result;
}

CUAResult *CUAToolBringToFront(NSDictionary *args) {
  pid_t pid = (pid_t)[args[@"pid"] integerValue];
  if (pid <= 0) pid = CUAFrontmostPid();
  NSRunningApplication *running = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (!running) return [CUAResult errorText:[NSString stringWithFormat:@"bring_to_front: no app with pid %d", pid]];
  [running activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  NSInteger windowID = [args[@"window_id"] integerValue];
  if (windowID > 0) {
    AXUIElementRef app = NULL;
    AXUIElementRef window = NULL;
    if (CUAAXWindowFor(pid, windowID, &app, &window)) {
      AXUIElementPerformAction(window, kAXRaiseAction);
      AXUIElementSetAttributeValue(window, kAXMainAttribute, kCFBooleanTrue);
      AXUIElementSetAttributeValue(window, kAXFocusedAttribute, kCFBooleanTrue);
      CFRelease(window);
      CFRelease(app);
    }
  }
  return [CUAResult text:[NSString stringWithFormat:@"brought %@ to the front",
                                                    running.localizedName ?: running.bundleIdentifier ?: @"the app"]];
}

CUAResult *CUAToolSetValue(NSDictionary *args) {
  NSString *token = [args[@"element_token"] isKindOfClass:[NSString class]] ? args[@"element_token"] : nil;
  if (!token.length) return [CUAResult errorText:@"set_value needs an element_token"];
  id value = args[@"value"];
  if (!value || value == [NSNull null]) return [CUAResult errorText:@"set_value needs a value"];
  if (([value isKindOfClass:[NSString class]] && [value length] > 10000)) {
    return [CUAResult errorText:@"set_value: value is longer than 10000 characters"];
  }
  AXUIElementRef element = NULL;
  pid_t pid = 0;
  if (!CUAResolveToken(token, &element, &pid)) return [CUAResult errorText:@"Unknown element_token; call get_window_state again."];
  AXError error = AXUIElementSetAttributeValue(element, kAXValueAttribute, (__bridge CFTypeRef)value);
  if (error != kAXErrorSuccess) {
    CUAAXFocus(element);
    NSString *text = [value isKindOfClass:[NSString class]] ? value : [value description];
    error = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute, (__bridge CFTypeRef)text);
  }
  if (error != kAXErrorSuccess) {
    return [CUAResult errorText:[NSString stringWithFormat:@"set_value failed: AX error %d", (int)error]];
  }
  return [CUAResult text:[NSString stringWithFormat:@"set the value of %@", token]];
}
