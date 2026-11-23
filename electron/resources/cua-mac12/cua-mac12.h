// macOS 12.3–14 computer-use helper. No ScreenCaptureKit, no Swift.
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ApplicationServices/ApplicationServices.h>

NS_ASSUME_NONNULL_BEGIN

typedef struct {
  double width;
  double height;
} CUASize;

/// One MCP content item: `text`, or `image` with its base64 PNG body.
@interface CUAContent : NSObject
@property (nonatomic, copy) NSString *kind;
@property (nonatomic, copy, nullable) NSString *text;
@property (nonatomic, copy, nullable) NSString *data;
@end

@interface CUAResult : NSObject
@property (nonatomic) BOOL isError;
@property (nonatomic, strong) NSMutableArray<CUAContent *> *content;
@property (nonatomic, strong, nullable) NSDictionary *structured;
+ (instancetype)text:(NSString *)text;
+ (instancetype)json:(id)value;
+ (instancetype)errorText:(NSString *)text;
- (void)addText:(NSString *)text;
- (void)addImageData:(NSData *)png;
- (NSDictionary *)payload;
@end

// AX element tokens (ax.m). A token is `ax:<pid>:<serial>`, valid until the next tree rebuild.
void CUAStoreReset(void);
NSString *CUAStoreAdd(pid_t pid, AXUIElementRef element);
AXUIElementRef _Nullable CUAStoreResolve(NSString * _Nullable token);
BOOL CUAResolveToken(NSString * _Nullable token, AXUIElementRef _Nullable * _Nullable element, pid_t * _Nullable pid);
BOOL CUAAXElementCenter(AXUIElementRef element, CGPoint *center);
BOOL CUAAXHasAction(AXUIElementRef element, CFStringRef action);
void CUAAXFocus(AXUIElementRef element);
/// The app element and its target AX window. Both are owned by the caller: CFRelease each.
BOOL CUAAXWindowFor(pid_t pid, NSInteger windowID, AXUIElementRef _Nullable * _Nullable appOut,
                    AXUIElementRef _Nullable * _Nullable windowOut);
pid_t CUAFrontmostPid(void);
NSString * _Nullable CUAFrontmostAppName(void);

// Permissions (main.m).
BOOL CUAAccessibilityGranted(BOOL prompt);
BOOL CUAScreenRecordingGranted(void);

// Capture (capture.m).
CGImageRef _Nullable CUACaptureDesktop(void);
CGImageRef _Nullable CUACaptureWindow(CGWindowID windowID);
CGWindowID CUAFrontWindowID(pid_t pid);
NSInteger CUAMaxImageDimension(NSDictionary *args);
/// Encodes the PNG, scaled down to `maxDimension` when its long side exceeds it; reports pixel sizes.
NSData * _Nullable CUAPNGForImage(CGImageRef image, NSInteger maxDimension,
                                  CUASize * _Nullable fullPixels, CUASize * _Nullable returnedPixels);
/// Writes `screenshot_out_file`; refuses a relative path or a missing parent directory.
BOOL CUAWritePNG(NSData *png, NSString *outFile, NSString * _Nullable * _Nullable errorText);
/// Appends the PNG to `result`, or writes `screenshot_out_file` and appends its path. Reports pixel sizes and a failure.
BOOL CUAEmitImage(CUAResult *result, CGImageRef image, NSInteger maxDimension, NSString * _Nullable outFile,
                  CUASize * _Nullable fullPixels, CUASize * _Nullable returnedPixels,
                  NSString * _Nullable * _Nullable errorText);

// Tool implementations, one file each.
CUAResult *CUAToolGetScreenSize(NSDictionary *args);
CUAResult *CUAToolGetDesktopState(NSDictionary *args);
CUAResult *CUAToolListWindows(NSDictionary *args);
CUAResult *CUAToolListApps(NSDictionary *args);
CUAResult *CUAToolLaunchApp(NSDictionary *args);
CUAResult *CUAToolZoom(NSDictionary *args);

CUAResult *CUAToolGetWindowState(NSDictionary *args);
CUAResult *CUAToolGetAccessibilityTree(NSDictionary *args);
CUAResult *CUAToolBringToFront(NSDictionary *args);
CUAResult *CUAToolSetValue(NSDictionary *args);
CUAResult *CUAToolClick(NSDictionary *args);
CUAResult *CUAToolDoubleClick(NSDictionary *args);
CUAResult *CUAToolRightClick(NSDictionary *args);
CUAResult *CUAToolDrag(NSDictionary *args);
CUAResult *CUAToolScroll(NSDictionary *args);
CUAResult *CUAToolTypeText(NSDictionary *args);
CUAResult *CUAToolPressKey(NSDictionary *args);
CUAResult *CUAToolHotkey(NSDictionary *args);
CUAResult *CUAToolMoveCursor(NSDictionary *args);
CUAResult *CUAToolGetCursorPosition(NSDictionary *args);

/// `arguments` is the parsed tools/call argument object; unknown optional fields are ignored.
NSDictionary *CUAHandleCall(NSString *name, NSDictionary *arguments);
/// One newline-delimited JSON-RPC frame in, one serialized response out; nil when the frame is a notification.
NSData * _Nullable CUAHandleRPC(NSData *frame);
void CUALoadTools(NSArray<NSDictionary *> *tools);
NSArray<NSDictionary *> *CUATools(void);
NSString *CUAJSONString(id _Nullable value);

NS_ASSUME_NONNULL_END
