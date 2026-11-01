#import <Foundation/Foundation.h>
#import "SocketConnection.h"
#include <unistd.h>
@interface SilentDelegate : NSObject <NSStreamDelegate>
@end
@implementation SilentDelegate
- (void)stream:(NSStream *)stream handleEvent:(NSStreamEvent)event {}
@end
int main(void) {
  @autoreleasepool {
    NSString *path = [@"/tmp/invizent-screen-" stringByAppendingString:NSUUID.UUID.UUIDString];
    SocketConnection *connection = [[SocketConnection alloc] initWithFilePath:path];
    if (!connection) return 1;
    SilentDelegate *delegate = [SilentDelegate new];
    [connection openWithStreamDelegate:delegate];
    dispatch_semaphore_t closed = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      [connection close]; dispatch_semaphore_signal(closed);
    });
    long result = dispatch_semaphore_wait(closed, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
    unlink(path.UTF8String);
    if (result != 0) { fprintf(stderr, "Closing capture before a client connected deadlocked\n"); return 1; }
    puts("Screen socket closes before ReplayKit connects");
    return 0;
  }
}
