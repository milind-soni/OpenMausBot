#import "cua-mac12.h"
#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>

static CGImageRef CUAImageFromFile(NSString *path) {
  NSData *data = [NSData dataWithContentsOfFile:path];
  [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
  if (!data.length) return NULL;
  CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
  if (!source) return NULL;
  CGImageRef image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
  CFRelease(source);
  return image;
}

static CGImageRef CUAImageFromScreencapture(NSArray<NSString *> *arguments) {
  NSString *path = [NSTemporaryDirectory()
    stringByAppendingPathComponent:[NSString stringWithFormat:@"cua-mac12-%d-%u.png", getpid(), arc4random()]];
  NSTask *task = [NSTask new];
  task.launchPath = @"/usr/sbin/screencapture";
  task.arguments = [arguments arrayByAddingObject:path];
  task.standardOutput = [NSPipe pipe];
  task.standardError = [NSPipe pipe];
  @try {
    [task launch];
    [task waitUntilExit];
  } @catch (NSException *exception) {
    return NULL;
  }
  if (task.terminationStatus != 0) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
    return NULL;
  }
  return CUAImageFromFile(path);
}

/// The union of every active display, so the fallback matches what CGWindowListCreateImage returns.
static NSString *CUADesktopRect(void) {
  uint32_t count = 0;
  CGGetActiveDisplayList(0, NULL, &count);
  if (count == 0) return nil;
  CGDirectDisplayID *displays = calloc(count, sizeof(CGDirectDisplayID));
  if (!displays) return nil;
  CGRect unionRect = CGRectNull;
  if (CGGetActiveDisplayList(count, displays, &count) == kCGErrorSuccess) {
    for (uint32_t index = 0; index < count; index++) {
      unionRect = CGRectUnion(unionRect, CGDisplayBounds(displays[index]));
    }
  }
  free(displays);
  if (CGRectIsNull(unionRect)) return nil;
  return [NSString stringWithFormat:@"-R%ld,%ld,%ld,%ld",
                                    (long)lround(unionRect.origin.x), (long)lround(unionRect.origin.y),
                                    (long)lround(unionRect.size.width), (long)lround(unionRect.size.height)];
}

CGImageRef CUACaptureDesktop(void) {
  CGImageRef image = CGWindowListCreateImage(CGRectInfinite, kCGWindowListOptionOnScreenOnly,
                                             kCGNullWindowID, kCGWindowImageDefault);
  if (image) return image;
  NSMutableArray<NSString *> *arguments = [NSMutableArray arrayWithObjects:@"-x", @"-o", nil];
  NSString *rect = CUADesktopRect();
  if (rect) [arguments addObject:rect];
  return CUAImageFromScreencapture(arguments);
}

CGImageRef CUACaptureWindow(CGWindowID windowID) {
  if (windowID == kCGNullWindowID) return NULL;
  CGImageRef image = CGWindowListCreateImage(CGRectNull, kCGWindowListOptionIncludingWindow,
                                             windowID, kCGWindowImageBoundsIgnoreFraming);
  if (image) return image;
  return CUAImageFromScreencapture(@[ @"-x", @"-o", [NSString stringWithFormat:@"-l%u", (unsigned)windowID] ]);
}

CGWindowID CUAFrontWindowID(pid_t pid) {
  if (pid <= 0) return kCGNullWindowID;
  NSArray<NSDictionary *> *windows = CFBridgingRelease(
    CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  for (NSDictionary *window in windows) {
    if ([window[(id)kCGWindowOwnerPID] intValue] != pid) continue;
    if ([window[(id)kCGWindowLayer] intValue] != 0) continue;
    return (CGWindowID)[window[(id)kCGWindowNumber] unsignedIntValue];
  }
  return kCGNullWindowID;
}

NSInteger CUAMaxImageDimension(NSDictionary *args) {
  NSInteger value = args[@"max_image_dimension"] ? [args[@"max_image_dimension"] integerValue] : 1568;
  if (value < 0) value = 0;
  if (value > 4096) value = 4096;
  return value;
}

/// Scales the image down when its long side exceeds `maxDimension`; returns the original when it already fits.
static CGImageRef CUAScaled(CGImageRef image, NSInteger maxDimension, CGImageRef *owned) {
  *owned = NULL;
  size_t width = CGImageGetWidth(image);
  size_t height = CGImageGetHeight(image);
  if (maxDimension <= 0 || (NSInteger)MAX(width, height) <= maxDimension) return image;
  double scale = (double)maxDimension / (double)MAX(width, height);
  size_t scaledWidth = MAX(1, (size_t)lround(width * scale));
  size_t scaledHeight = MAX(1, (size_t)lround(height * scale));
  CGColorSpaceRef space = CGColorSpaceCreateDeviceRGB();
  CGContextRef context = CGBitmapContextCreate(NULL, scaledWidth, scaledHeight, 8, 0, space,
                                               kCGImageAlphaPremultipliedFirst | kCGBitmapByteOrder32Little);
  CGColorSpaceRelease(space);
  if (!context) return image;
  CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
  CGContextDrawImage(context, CGRectMake(0, 0, scaledWidth, scaledHeight), image);
  CGImageRef scaled = CGBitmapContextCreateImage(context);
  CGContextRelease(context);
  if (!scaled) return image;
  *owned = scaled;
  return scaled;
}

static NSData *CUAPNGData(CGImageRef image) {
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
  return [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

NSData *CUAPNGForImage(CGImageRef image, NSInteger maxDimension, CUASize *fullPixels, CUASize *returnedPixels) {
  CGImageRef owned = NULL;
  CGImageRef scaled = CUAScaled(image, maxDimension, &owned);
  if (fullPixels) {
    fullPixels->width = (double)CGImageGetWidth(image);
    fullPixels->height = (double)CGImageGetHeight(image);
  }
  if (returnedPixels) {
    returnedPixels->width = (double)CGImageGetWidth(scaled);
    returnedPixels->height = (double)CGImageGetHeight(scaled);
  }
  NSData *png = CUAPNGData(scaled);
  if (owned) CGImageRelease(owned);
  return png.length ? png : nil;
}

BOOL CUAWritePNG(NSData *png, NSString *outFile, NSString **errorText) {
  if (![outFile hasPrefix:@"/"] ||
      ![[NSFileManager defaultManager] fileExistsAtPath:[outFile stringByDeletingLastPathComponent]]) {
    if (errorText) *errorText = @"screenshot_out_file must be an absolute path in an existing directory";
    return NO;
  }
  NSError *error = nil;
  if (![png writeToFile:outFile options:NSDataWritingAtomic error:&error]) {
    if (errorText) *errorText = [NSString stringWithFormat:@"could not write screenshot_out_file: %@", error.localizedDescription];
    return NO;
  }
  return YES;
}

BOOL CUAEmitImage(CUAResult *result, CGImageRef image, NSInteger maxDimension, NSString *outFile,
                  CUASize *fullPixels, CUASize *returnedPixels, NSString **errorText) {
  NSData *png = CUAPNGForImage(image, maxDimension, fullPixels, returnedPixels);
  if (!png) {
    if (errorText) *errorText = @"could not encode the screenshot as PNG";
    return NO;
  }
  if (outFile.length) {
    if (!CUAWritePNG(png, outFile, errorText)) return NO;
    [result addText:[NSString stringWithFormat:@"screenshot written to %@", outFile]];
    return YES;
  }
  [result addImageData:png];
  return YES;
}

static NSDictionary *CUAScreenSize(void) {
  CGDirectDisplayID display = CGMainDisplayID();
  CGRect bounds = CGDisplayBounds(display);
  size_t pixelsWide = CGDisplayPixelsWide(display);
  size_t pixelsHigh = CGDisplayPixelsHigh(display);
  double scale = bounds.size.width > 0 ? (double)pixelsWide / bounds.size.width : 1;
  return @{ @"width": @((long)lround(bounds.size.width)),
            @"height": @((long)lround(bounds.size.height)),
            @"pixel_width": @((long)pixelsWide),
            @"pixel_height": @((long)pixelsHigh),
            @"scale_factor": @(lround(scale * 100) / 100.0) };
}

CUAResult *CUAToolGetScreenSize(NSDictionary *args) {
  return [CUAResult text:CUAJSONString(CUAScreenSize())];
}

CUAResult *CUAToolGetDesktopState(NSDictionary *args) {
  NSString *app = CUAFrontmostAppName() ?: @"unknown";
  if (!CUAScreenRecordingGranted()) return [CUAResult errorText:@"Screen Recording required"];
  CGImageRef image = CUACaptureDesktop();
  if (!image) return [CUAResult errorText:@"desktop capture failed"];
  NSMutableString *text = [NSMutableString string];
  [text appendFormat:@"frontmost app: %@\n%@\n", app, CUAJSONString(CUAScreenSize())];
  [text appendFormat:@"image: %ldx%ld", (long)CGImageGetWidth(image), (long)CGImageGetHeight(image)];
  CUAResult *result = [CUAResult text:text];
  NSString *outFile = [args[@"screenshot_out_file"] isKindOfClass:[NSString class]] ? args[@"screenshot_out_file"] : nil;
  NSString *errorText = nil;
  BOOL ok = CUAEmitImage(result, image, CUAMaxImageDimension(args), outFile, NULL, NULL, &errorText);
  CGImageRelease(image);
  if (!ok) return [CUAResult errorText:errorText ?: @"desktop capture failed"];
  return result;
}

CUAResult *CUAToolListWindows(NSDictionary *args) {
  BOOL onScreenOnly = args[@"on_screen_only"] ? [args[@"on_screen_only"] boolValue] : YES;
  CGWindowListOption option = onScreenOnly
    ? (kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements)
    : kCGWindowListOptionAll;
  NSArray<NSDictionary *> *raw = CFBridgingRelease(CGWindowListCopyWindowInfo(option, kCGNullWindowID));
  NSInteger pid = [args[@"pid"] integerValue];
  NSString *app = [args[@"app"] isKindOfClass:[NSString class]] ? args[@"app"] : nil;
  NSMutableArray *windows = [NSMutableArray array];
  for (NSDictionary *window in raw) {
    if (pid > 0 && [window[(id)kCGWindowOwnerPID] intValue] != pid) continue;
    NSString *owner = window[(id)kCGWindowOwnerName] ?: @"";
    if (app.length && [owner rangeOfString:app options:NSCaseInsensitiveSearch].location == NSNotFound) continue;
    NSDictionary *bounds = window[(id)kCGWindowBounds] ?: @{};
    [windows addObject:@{
      @"window_id": @([window[(id)kCGWindowNumber] unsignedIntValue]),
      @"pid": @([window[(id)kCGWindowOwnerPID] intValue]),
      @"app": owner,
      @"title": window[(id)kCGWindowName] ?: @"",
      @"bounds": @{ @"x": @([bounds[@"X"] doubleValue]),
                    @"y": @([bounds[@"Y"] doubleValue]),
                    @"width": @([bounds[@"Width"] doubleValue]),
                    @"height": @([bounds[@"Height"] doubleValue]) },
      @"layer": @([window[(id)kCGWindowLayer] intValue]),
      @"on_screen": @([window[(id)kCGWindowIsOnscreen] boolValue]),
    }];
  }
  return [CUAResult json:@{ @"windows": windows }];
}

CUAResult *CUAToolListApps(NSDictionary *args) {
  NSMutableArray *apps = [NSMutableArray array];
  for (NSRunningApplication *app in [NSWorkspace sharedWorkspace].runningApplications) {
    if (app.activationPolicy == NSApplicationActivationPolicyProhibited) continue;
    [apps addObject:@{ @"pid": @(app.processIdentifier),
                       @"name": app.localizedName ?: @"",
                       @"bundle_id": app.bundleIdentifier ?: @"",
                       @"active": @(app.isActive),
                       @"hidden": @(app.isHidden) }];
  }
  [apps sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) {
    return [a[@"name"] localizedCaseInsensitiveCompare:b[@"name"]];
  }];
  return [CUAResult json:@{ @"apps": apps }];
}

static NSURL *CUAApplicationURL(NSDictionary *args) {
  NSString *bundleID = [args[@"bundle_id"] isKindOfClass:[NSString class]] ? args[@"bundle_id"] : nil;
  NSString *name = [args[@"name"] isKindOfClass:[NSString class]] ? args[@"name"] : nil;
  if (bundleID.length) return [[NSWorkspace sharedWorkspace] URLForApplicationWithBundleIdentifier:bundleID];
  if (name.length) {
    NSString *path = [[NSWorkspace sharedWorkspace] fullPathForApplication:name];
    return path.length ? [NSURL fileURLWithPath:path] : nil;
  }
  return nil;
}

static NSRunningApplication *CUAWaitForApplication(NSURL *url) {
  for (int attempt = 0; attempt < 40; attempt++) {
    for (NSRunningApplication *app in [NSWorkspace sharedWorkspace].runningApplications) {
      if ([app.bundleURL.path isEqualToString:url.path]) return app;
    }
    usleep(50 * 1000);
  }
  return nil;
}

CUAResult *CUAToolLaunchApp(NSDictionary *args) {
  NSMutableArray<NSString *> *urls = [NSMutableArray array];
  if ([args[@"urls"] isKindOfClass:[NSArray class]]) {
    for (id entry in args[@"urls"]) {
      if ([entry isKindOfClass:[NSString class]]) [urls addObject:entry];
    }
  }
  NSArray<NSString *> *extraArguments = [args[@"additional_arguments"] isKindOfClass:[NSArray class]]
    ? args[@"additional_arguments"] : @[];
  NSURL *appURL = CUAApplicationURL(args);
  NSString *label = [args[@"bundle_id"] isKindOfClass:[NSString class]] ? args[@"bundle_id"]
    : ([args[@"name"] isKindOfClass:[NSString class]] ? args[@"name"] : nil);

  if (urls.count) {
    NSMutableArray<NSURL *> *openURLs = [NSMutableArray array];
    for (NSString *entry in urls) {
      NSURL *url = [NSURL URLWithString:entry];
      if (url) [openURLs addObject:url];
    }
    if (!openURLs.count) return [CUAResult errorText:@"launch_app: urls are not valid"];
    if (appURL) {
      NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
      configuration.arguments = extraArguments;
      configuration.createsNewApplicationInstance = [args[@"creates_new_application_instance"] boolValue];
      __block NSError *launchError = nil;
      dispatch_semaphore_t done = dispatch_semaphore_create(0);
      [[NSWorkspace sharedWorkspace] openURLs:openURLs withApplicationAtURL:appURL configuration:configuration
                            completionHandler:^(NSRunningApplication *app, NSError *error) {
        launchError = error;
        dispatch_semaphore_signal(done);
      }];
      dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)));
      if (launchError) return [CUAResult errorText:[NSString stringWithFormat:@"launch_app failed: %@", launchError.localizedDescription]];
      return [CUAResult text:[NSString stringWithFormat:@"opened %lu url(s) in %@",
                                                     (unsigned long)openURLs.count, label ?: appURL.lastPathComponent]];
    }
    NSInteger opened = 0;
    for (NSURL *url in openURLs) {
      if ([[NSWorkspace sharedWorkspace] openURL:url]) opened++;
    }
    if (opened == 0) return [CUAResult errorText:@"launch_app: no URL could be opened"];
    return [CUAResult text:[NSString stringWithFormat:@"opened %ld url(s)", (long)opened]];
  }

  if (!appURL) {
    return [CUAResult errorText:[NSString stringWithFormat:@"launch_app: no application matches %@", label ?: @"(none given)"]];
  }
  NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
  configuration.arguments = extraArguments;
  configuration.createsNewApplicationInstance = [args[@"creates_new_application_instance"] boolValue];
  __block NSError *launchError = nil;
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [[NSWorkspace sharedWorkspace] openApplicationAtURL:appURL configuration:configuration
                                      completionHandler:^(NSRunningApplication *app, NSError *error) {
    launchError = error;
    dispatch_semaphore_signal(done);
  }];
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)));
  if (launchError) return [CUAResult errorText:[NSString stringWithFormat:@"launch_app failed: %@", launchError.localizedDescription]];
  NSRunningApplication *app = CUAWaitForApplication(appURL);
  if (!app) {
    return [CUAResult errorText:[NSString stringWithFormat:@"launch_app: %@ did not appear as a running app",
                                                           label ?: appURL.lastPathComponent]];
  }
  return [CUAResult json:@{ @"pid": @(app.processIdentifier),
                            @"bundle_id": app.bundleIdentifier ?: @"",
                            @"name": app.localizedName ?: @"" }];
}

CUAResult *CUAToolZoom(NSDictionary *args) {
  if (!CUAScreenRecordingGranted()) return [CUAResult errorText:@"Screen Recording required"];
  NSInteger pid = [args[@"pid"] integerValue];
  if (pid <= 0) pid = CUAFrontmostPid();
  CGWindowID windowID = (CGWindowID)[args[@"window_id"] integerValue];
  if (windowID == kCGNullWindowID) windowID = CUAFrontWindowID(pid);
  if (windowID == kCGNullWindowID) return [CUAResult errorText:@"zoom: no window to capture"];
  CGImageRef image = CUACaptureWindow(windowID);
  if (!image) return [CUAResult errorText:@"window capture failed"];
  double width = (double)CGImageGetWidth(image);
  double height = (double)CGImageGetHeight(image);
  double x1 = [args[@"x1"] doubleValue];
  double y1 = [args[@"y1"] doubleValue];
  double x2 = [args[@"x2"] doubleValue];
  double y2 = [args[@"y2"] doubleValue];
  x1 = MAX(0, MIN(x1, width));
  y1 = MAX(0, MIN(y1, height));
  x2 = MAX(0, MIN(x2, width));
  y2 = MAX(0, MIN(y2, height));
  if (x2 <= x1 || y2 <= y1) {
    CGImageRelease(image);
    return [CUAResult errorText:@"zoom: x2 must be greater than x1 and y2 greater than y1"];
  }
  CGImageRef cropped = CGImageCreateWithImageInRect(image, CGRectMake(x1, y1, x2 - x1, y2 - y1));
  if (!cropped) {
    CGImageRelease(image);
    return [CUAResult errorText:@"zoom: could not crop that region"];
  }
  CUAResult *result = [CUAResult text:CUAJSONString(@{ @"window_id": @((unsigned)windowID),
                                                        @"x1": @(x1), @"x2": @(x2), @"y1": @(y1), @"y2": @(y2),
                                                        @"width": @(width), @"height": @(height) })];
  NSString *errorText = nil;
  BOOL ok = CUAEmitImage(result, cropped, 0, nil, NULL, NULL, &errorText);
  CGImageRelease(cropped);
  CGImageRelease(image);
  if (!ok) return [CUAResult errorText:errorText ?: @"zoom: could not encode the crop"];
  return result;
}
