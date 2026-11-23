#import "cua-mac12.h"

static NSDictionary *CUAErrorResponse(id identifier, NSInteger code, NSString *message) {
  return @{ @"jsonrpc": @"2.0",
            @"id": identifier ?: [NSNull null],
            @"error": @{ @"code": @(code), @"message": message } };
}

static NSData *CUASerialize(id response) {
  return [NSJSONSerialization dataWithJSONObject:response options:0 error:NULL];
}

NSData *CUAHandleRPC(NSData *frame) {
  if (frame.length == 0) return nil;
  NSError *error = nil;
  id parsed = [NSJSONSerialization JSONObjectWithData:frame options:0 error:&error];
  if (!parsed) return CUASerialize(CUAErrorResponse(nil, -32700, @"Parse error"));
  if (![parsed isKindOfClass:[NSDictionary class]]) {
    return CUASerialize(CUAErrorResponse(nil, -32600, @"Invalid Request"));
  }
  NSDictionary *request = parsed;
  id identifier = request[@"id"];
  id method = request[@"method"];
  if (![method isKindOfClass:[NSString class]]) {
    return identifier ? CUASerialize(CUAErrorResponse(identifier, -32600, @"Invalid Request")) : nil;
  }
  // Notifications carry no id and never get a response.
  if (!identifier) return nil;
  id params = [request[@"params"] isKindOfClass:[NSDictionary class]] ? request[@"params"] : @{};

  NSDictionary *response;
  if ([method isEqualToString:@"initialize"]) {
    NSString *protocolVersion = [params[@"protocolVersion"] isKindOfClass:[NSString class]]
      ? params[@"protocolVersion"] : @"2025-03-26";
    response = @{ @"jsonrpc": @"2.0",
                  @"id": identifier,
                  @"result": @{ @"protocolVersion": protocolVersion,
                                @"capabilities": @{ @"tools": @{} },
                                @"serverInfo": @{ @"name": @"cua-driver-mac12", @"version": @"1.0.0" } } };
  } else if ([method isEqualToString:@"ping"]) {
    response = @{ @"jsonrpc": @"2.0", @"id": identifier, @"result": @{} };
  } else if ([method isEqualToString:@"tools/list"]) {
    response = @{ @"jsonrpc": @"2.0", @"id": identifier, @"result": @{ @"tools": CUATools() } };
  } else if ([method isEqualToString:@"tools/call"]) {
    id name = params[@"name"];
    if (![name isKindOfClass:[NSString class]] || [name length] == 0) {
      response = @{ @"jsonrpc": @"2.0", @"id": identifier,
                    @"result": @{ @"content": @[ @{ @"type": @"text", @"text": @"missing tool name" } ], @"isError": @YES } };
    } else {
      response = @{ @"jsonrpc": @"2.0", @"id": identifier, @"result": CUAHandleCall(name, params[@"arguments"]) };
    }
  } else {
    response = CUAErrorResponse(identifier, -32601, [NSString stringWithFormat:@"Method not found: %@", method]);
  }
  return CUASerialize(response);
}
