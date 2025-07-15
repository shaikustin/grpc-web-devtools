// Copyright (c) 2019 SafetyCulture Pty Ltd. All Rights Reserved.

const injectContent = `

// Intercept XMLHttpRequest to capture response headers and attach them to gRPC responses
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;
const activeRequests = new Map();

// Global storage for the most recent headers (fallback)
let mostRecentHeaders = {};
let mostRecentHeadersTimestamp = 0;

XMLHttpRequest.prototype.open = function(method, url, ...args) {
  this._url = url;
  this._method = method;
  this._requestId = Date.now() + Math.random();
  return originalXHROpen.call(this, method, url, ...args);
};

XMLHttpRequest.prototype.send = function(data) {
  const xhr = this;
  const originalOnReadyStateChange = xhr.onreadystatechange;
  
  // Store request info for gRPC-related requests
  if (xhr._url && (xhr._url.includes('twirp') || xhr._url.includes('grpc') || xhr._url.includes('/gw/'))) {
    activeRequests.set(xhr._requestId, {
      url: xhr._url,
      method: xhr._method,
      startTime: Date.now(),
      xhr: xhr
    });
  }
  
  xhr.onreadystatechange = function() {
    if (xhr.readyState === 4 && xhr._url && (xhr._url.includes('twirp') || xhr._url.includes('grpc') || xhr._url.includes('/gw/'))) {
      // Parse response headers
      const headers = {};
      const responseHeaders = xhr.getAllResponseHeaders();
      if (responseHeaders) {
        responseHeaders.split('\\r\\n').forEach(line => {
          const parts = line.split(': ');
          if (parts.length === 2) {
            headers[parts[0].toLowerCase()] = parts[1];
          }
        });
      }
      
      // Store as most recent headers for fallback
      const now = Date.now();
      mostRecentHeaders = headers;
      mostRecentHeadersTimestamp = now;
      
      // Store directly on the XHR object for immediate access
      xhr._grpcHeaders = headers;
      
      
      // Clean up
      activeRequests.delete(xhr._requestId);
    }
    
    if (originalOnReadyStateChange) {
      originalOnReadyStateChange.call(xhr);
    }
  };
  
  return originalXHRSend.call(this, data);
};

// Function to find headers for a gRPC method
function findHeadersForMethod(method) {
  // First, try to find headers from active/recent XHR requests
  const now = Date.now();
  
  // Check active requests
  for (const [requestId, requestInfo] of activeRequests.entries()) {
    if (requestInfo.xhr && requestInfo.xhr._grpcHeaders) {
      return requestInfo.xhr._grpcHeaders;
    }
  }
  
  // Fallback to most recent headers if they're fresh (within 2 seconds)
  if (now - mostRecentHeadersTimestamp < 2000 && Object.keys(mostRecentHeaders).length > 0) {
    return mostRecentHeaders;
  }
  
  return {};
}

window.__GRPCWEB_DEVTOOLS__ = function (clients) {
  if (clients.constructor !== Array) {
    return
  }
  const postType = "__GRPCWEB_DEVTOOLS__";
  var StreamInterceptor = function (method, request, stream) {
    this._callbacks = {};
    const methodType = "server_streaming";
    window.postMessage({
      type: postType,
      method,
      methodType,
      request: request.toObject(),
    });
    stream.on('data', response => {
      window.postMessage({
        type: postType,
        method,
        methodType,
        response: response.toObject(),
      });
      if (!!this._callbacks['data']) {
        this._callbacks['data'](response);
      }
    });
    stream.on('status', status => {
      if (status.code === 0) {
        window.postMessage({
          type: postType,
          method,
          methodType,
          response: "EOF",
        });
      }
      if (!!this._callbacks['status']) {
        this._callbacks['status'](status);
      }
    });
    stream.on('error', error => {
      if (error.code !== 0) {
        window.postMessage({
          type: postType,
          method,
          methodType,
          error: {
            code: error.code,
            message: error.message,
          },
        });
      }
      if (!!this._callbacks['error']) {
        this._callbacks['error'](error);
      }
    });
    this._stream = stream;
  }
  StreamInterceptor.prototype.on = function (type, callback) {
    this._callbacks[type] = callback;
    return this;
  }
  StreamInterceptor.prototype.cancel = function () {
    this._stream.cancel()
  }
  clients.map(client => {
    client.client_.rpcCall_ = client.client_.rpcCall;
    client.client_.rpcCall2 = function (method, request, metadata, methodInfo, callback) {
      var posted = false;
      var originalCallback = callback;
      
      // Store the call object to access its metadata later
      var call = this.rpcCall_(method, request, metadata, methodInfo, function (err, response) {
        if (!posted) {
          // Extract response headers from different sources
          var responseHeaders = {};
          
          // Try multiple ways to get headers from the call object
          if (call) {
            // Try getResponseHeaders
            if (call.getResponseHeaders) {
              var headers = call.getResponseHeaders();
              if (headers) {
                for (var key in headers) {
                  responseHeaders[key] = headers[key];
                }
              }
            }
            
            // Try getMetadata
            if (call.getMetadata) {
              var metadata = call.getMetadata();
              if (metadata) {
                for (var key in metadata) {
                  responseHeaders[key] = metadata[key];
                }
              }
            }
            
            // Try accessing headers_ property directly
            if (call.headers_) {
              for (var key in call.headers_) {
                responseHeaders[key] = call.headers_[key];
              }
            }
            
            // Try accessing response headers from the call's response
            if (call.response && call.response.headers) {
              for (var key in call.response.headers) {
                responseHeaders[key] = call.response.headers[key];
              }
            }
          }
          
          // Also try to get headers from response object
          if (response && response.getResponseHeaders) {
            var headers = response.getResponseHeaders();
            if (headers) {
              for (var key in headers) {
                responseHeaders[key] = headers[key];
              }
            }
          }
          
          // Try to get headers from response metadata
          if (response && response.getMetadata) {
            var metadata = response.getMetadata();
            if (metadata) {
              for (var key in metadata) {
                responseHeaders[key] = metadata[key];
              }
            }
          }
          
          // If no headers found from gRPC sources, try XHR headers
          if (Object.keys(responseHeaders).length === 0) {
            const xhrHeaders = findHeadersForMethod(method);
            if (xhrHeaders && Object.keys(xhrHeaders).length > 0) {
              Object.assign(responseHeaders, xhrHeaders);
            }
          }
          
          // Get hostname from XHR requests
          let requestHostname = window.location.hostname;
          for (const [requestId, requestInfo] of activeRequests.entries()) {
            if (requestInfo.url) {
              try {
                const url = new URL(requestInfo.url);
                requestHostname = url.hostname;
                break;
              } catch (e) {
                // Keep default
              }
            }
          }
          
          
          window.postMessage({
            type: postType,
            method,
            methodType: "unary",
            request: request.toObject(),
            response: err ? undefined : response.toObject(),
            responseHeaders: responseHeaders,
            error: err || undefined,
            url: window.location.href,
            hostname: requestHostname,
          }, "*")
          posted = true;
        }
        originalCallback(err, response)
      });
      
      return call;
    }
    client.client_.rpcCall = client.client_.rpcCall2;
    client.client_.unaryCall = function (method, request, metadata, methodInfo) {
      return new Promise((resolve, reject) => {
        this.rpcCall2(method, request, metadata, methodInfo, function (error, response) {
          error ? reject(error) : resolve(response);
        });
      });
    };
    
    // Also intercept the raw transport to capture headers
    if (client.client_.transport_) {
      const originalTransport = client.client_.transport_;
      const originalCall = originalTransport.call;
      
      originalTransport.call = function(method, request, metadata, methodInfo, callback) {
        const wrappedCallback = function(err, response) {
          if (response && response.getResponseHeaders) {
            // Store headers in the response object for later access
            const headers = response.getResponseHeaders();
            if (headers) {
              response._devtoolsHeaders = headers;
            }
          }
          callback(err, response);
        };
        return originalCall.call(this, method, request, metadata, methodInfo, wrappedCallback);
      };
    }
    client.client_.serverStreaming_ = client.client_.serverStreaming;
    client.client_.serverStreaming2 = function (method, request, metadata, methodInfo) {
      var stream = client.client_.serverStreaming_(method, request, metadata, methodInfo);
      var si = new StreamInterceptor(method, request, stream);
      return si;
    }
    client.client_.serverStreaming = client.client_.serverStreaming2;
  })
}
`
// Inject script for grpc-web
let s = document.createElement('script');
s.type = 'text/javascript';
const scriptNode = document.createTextNode(injectContent);
s.appendChild(scriptNode);
(document.head || document.documentElement).appendChild(s);
s.parentNode.removeChild(s);

// Inject script for connect-web
var cs = document.createElement('script');
cs.src = chrome.runtime.getURL('connect-web-interceptor.js');
cs.onload = function () {
  this.remove();
};
(document.head || document.documentElement).appendChild(cs);

var port;

function setupPortIfNeeded() {
  if (!port && chrome && chrome.runtime) {
    port = chrome.runtime.connect(null, { name: "content" });
    port.postMessage({ action: "init" });
    port.onDisconnect.addListener(() => {
      port = null;
      window.removeEventListener("message", handleMessageEvent, false);
    });
  }
}

function sendGRPCNetworkCall(data) {
  setupPortIfNeeded();
  if (port) {
    port.postMessage({
      action: "gRPCNetworkCall",
      target: "panel",
      data,
    });
  }
}

function handleMessageEvent(event) {
  if (event.source != window) return;
  if (event.data.type && event.data.type == "__GRPCWEB_DEVTOOLS__") {
    sendGRPCNetworkCall(event.data);
  }
}

window.addEventListener("message", handleMessageEvent, false);
