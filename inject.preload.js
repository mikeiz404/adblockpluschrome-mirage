/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-2017 eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

"use strict";

let randomEventName = "abp-request-" + Math.random().toString(36).substr(2);

// Proxy "should we block?" messages from checkRequest inside the injected
// code to the background page and back again.
document.addEventListener(randomEventName, event =>
{
  let {url, requestType} = event.detail;

  ext.backgroundPage.sendMessage({
    type: "request.blockedByWrapper",
    requestType,
    url
  }, block =>
  {
    document.dispatchEvent(new CustomEvent(
      randomEventName + "-" + requestType + "-" + url, {detail: block}
    ));
  });
});

function injected(eventName, injectedIntoContentWindow)
{
  let checkRequest;

  /*
   * Frame context wrapper
   *
   * For some edge-cases Chrome will not run content scripts inside of frames.
   * Website have started to abuse this fact to access unwrapped APIs via a
   * frame's contentWindow (#4586, 5207). Therefore until Chrome runs content
   * scripts consistently for all frames we must take care to (re)inject our
   * wrappers when the contentWindow is accessed.
   */
  let injectedToString = Function.prototype.toString.bind(injected);
  let injectedFrames = new WeakSet();
  let injectedFramesAdd = WeakSet.prototype.add.bind(injectedFrames);
  let injectedFramesHas = WeakSet.prototype.has.bind(injectedFrames);

  function injectIntoContentWindow(contentWindow)
  {
    if (contentWindow && !injectedFramesHas(contentWindow))
    {
      injectedFramesAdd(contentWindow);
      try
      {
        contentWindow[eventName] = checkRequest;
        contentWindow.eval(
          "(" + injectedToString() + ")('" + eventName + "', true);"
        );
        delete contentWindow[eventName];
      }
      catch (e) {}
    }
  }

  for (let element of [HTMLFrameElement, HTMLIFrameElement, HTMLObjectElement])
  {
    let contentDocumentDesc = Object.getOwnPropertyDescriptor(
      element.prototype, "contentDocument"
    );
    let contentWindowDesc = Object.getOwnPropertyDescriptor(
      element.prototype, "contentWindow"
    );

    // Apparently in HTMLObjectElement.prototype.contentWindow does not exist
    // in older versions of Chrome such as 42.
    if (!contentWindowDesc)
      continue;

    let getContentDocument = Function.prototype.call.bind(
      contentDocumentDesc.get
    );
    let getContentWindow = Function.prototype.call.bind(
      contentWindowDesc.get
    );

    contentWindowDesc.get = function()
    {
      let contentWindow = getContentWindow(this);
      injectIntoContentWindow(contentWindow);
      return contentWindow;
    };
    contentDocumentDesc.get = function()
    {
      injectIntoContentWindow(getContentWindow(this));
      return getContentDocument(this);
    };
    Object.defineProperty(element.prototype, "contentWindow",
                          contentWindowDesc);
    Object.defineProperty(element.prototype, "contentDocument",
                          contentDocumentDesc);
  }

  /*
   * Shadow root getter wrapper
   *
   * After creating our shadowRoot we must wrap the getter to prevent the
   * website from accessing it (#4191, #4298). This is required as a
   * workaround for the lack of user style support in Chrome.
   * See https://bugs.chromium.org/p/chromium/issues/detail?id=632009&desc=2
   */
  let originalShadowRoot = document.documentElement.shadowRoot;
  if ("shadowRoot" in Element.prototype)
  {
    let ourShadowRoot = document.documentElement.shadowRoot;
    if (ourShadowRoot)
    {
      let desc = Object.getOwnPropertyDescriptor(Element.prototype,
                                                 "shadowRoot");
      let shadowRoot = Function.prototype.call.bind(desc.get);

      Object.defineProperty(Element.prototype, "shadowRoot", {
        configurable: true, enumerable: true, get()
        {
          let thisShadow = shadowRoot(this);
          return thisShadow == ourShadowRoot ? null : thisShadow;
        }
      });
    }
  }

  /*
   * Shared request checking code, used by both the WebSocket and
   * RTCPeerConnection wrappers.
   */
  let RealCustomEvent = window.CustomEvent;

  // If we've been injected into a frame via contentWindow then we can simply
  // grab the copy of checkRequest left for us by the parent document. Otherwise
  // we need to set it up now, along with the event handling functions.
  if (injectedIntoContentWindow)
    checkRequest = window[eventName];
  else
  {
    let addEventListener = document.addEventListener.bind(document);
    let dispatchEvent = document.dispatchEvent.bind(document);
    let removeEventListener = document.removeEventListener.bind(document);
    checkRequest = (requestType, url, callback) =>
    {
      let incomingEventName = eventName + "-" + requestType + "-" + url;

      function listener(event)
      {
        callback(event.detail);
        removeEventListener(incomingEventName, listener);
      }
      addEventListener(incomingEventName, listener);

      dispatchEvent(new RealCustomEvent(eventName,
                                        {detail: {url, requestType}}));
    };
  }

  // Only to be called before the page's code, not hardened.
  function copyProperties(src, dest, properties)
  {
    for (let name of properties)
    {
      if (src.hasOwnProperty(name))
      {
        Object.defineProperty(dest, name,
                              Object.getOwnPropertyDescriptor(src, name));
      }
    }
  }

  /*
   * WebSocket wrapper
   *
   * Required before Chrome 58, since the webRequest API didn't allow us to
   * intercept WebSockets.
   * See https://bugs.chromium.org/p/chromium/issues/detail?id=129353
   */
  let RealWebSocket = WebSocket;
  let closeWebSocket = Function.prototype.call.bind(
    RealWebSocket.prototype.close
  );

  function WrappedWebSocket(url, ...args)
  {
    // Throw correct exceptions if the constructor is used improperly.
    if (!(this instanceof WrappedWebSocket)) return RealWebSocket();
    if (arguments.length < 1) return new RealWebSocket();

    let websocket = new RealWebSocket(url, ...args);

    checkRequest("websocket", websocket.url, blocked =>
    {
      if (blocked)
        closeWebSocket(websocket);
    });

    return websocket;
  }
  WrappedWebSocket.prototype = RealWebSocket.prototype;
  window.WebSocket = WrappedWebSocket.bind();
  copyProperties(RealWebSocket, WebSocket,
                 ["CONNECTING", "OPEN", "CLOSING", "CLOSED", "prototype"]);
  RealWebSocket.prototype.constructor = WebSocket;

  /*
   * RTCPeerConnection wrapper
   *
   * The webRequest API in Chrome does not yet allow the blocking of
   * WebRTC connections.
   * See https://bugs.chromium.org/p/chromium/issues/detail?id=707683
   */
  let RealRTCPeerConnection = window.RTCPeerConnection ||
                                window.webkitRTCPeerConnection;
  let closeRTCPeerConnection = Function.prototype.call.bind(
    RealRTCPeerConnection.prototype.close
  );
  let RealArray = Array;
  let RealString = String;
  let {create: createObject, defineProperty} = Object;

  function normalizeUrl(url)
  {
    if (typeof url != "undefined")
      return RealString(url);
  }

  function safeCopyArray(originalArray, transform)
  {
    if (originalArray == null || typeof originalArray != "object")
      return originalArray;

    let safeArray = RealArray(originalArray.length);
    for (let i = 0; i < safeArray.length; i++)
    {
      defineProperty(safeArray, i, {
        configurable: false, enumerable: false, writable: false,
        value: transform(originalArray[i])
      });
    }
    defineProperty(safeArray, "length", {
      configurable: false, enumerable: false, writable: false,
      value: safeArray.length
    });
    return safeArray;
  }

  // It would be much easier to use the .getConfiguration method to obtain
  // the normalized and safe configuration from the RTCPeerConnection
  // instance. Unfortunately its not implemented as of Chrome unstable 59.
  // See https://www.chromestatus.com/feature/5271355306016768
  function protectConfiguration(configuration)
  {
    if (configuration == null || typeof configuration != "object")
      return configuration;

    let iceServers = safeCopyArray(
      configuration.iceServers,
      iceServer =>
      {
        let {url, urls} = iceServer;

        // RTCPeerConnection doesn't iterate through pseudo Arrays of urls.
        if (typeof urls != "undefined" && !(urls instanceof RealArray))
          urls = [urls];

        return createObject(iceServer, {
          url: {
            configurable: false, enumerable: false, writable: false,
            value: normalizeUrl(url)
          },
          urls: {
            configurable: false, enumerable: false, writable: false,
            value: safeCopyArray(urls, normalizeUrl)
          }
        });
      }
    );

    return createObject(configuration, {
      iceServers: {
        configurable: false, enumerable: false, writable: false,
        value: iceServers
      }
    });
  }

  function checkUrl(peerconnection, url)
  {
    checkRequest("webrtc", url, blocked =>
    {
      if (blocked)
      {
        // Calling .close() throws if already closed.
        try
        {
          closeRTCPeerConnection(peerconnection);
        }
        catch (e) {}
      }
    });
  }

  function checkConfiguration(peerconnection, configuration)
  {
    if (configuration && configuration.iceServers)
    {
      for (let i = 0; i < configuration.iceServers.length; i++)
      {
        let iceServer = configuration.iceServers[i];
        if (iceServer)
        {
          if (iceServer.url)
            checkUrl(peerconnection, iceServer.url);

          if (iceServer.urls)
          {
            for (let j = 0; j < iceServer.urls.length; j++)
              checkUrl(peerconnection, iceServer.urls[j]);
          }
        }
      }
    }
  }

  // Chrome unstable (tested with 59) has already implemented
  // setConfiguration, so we need to wrap that if it exists too.
  // https://www.chromestatus.com/feature/5596193748942848
  if (RealRTCPeerConnection.prototype.setConfiguration)
  {
    let realSetConfiguration = Function.prototype.call.bind(
      RealRTCPeerConnection.prototype.setConfiguration
    );

    RealRTCPeerConnection.prototype.setConfiguration = function(configuration)
    {
      configuration = protectConfiguration(configuration);

      // Call the real method first, so that validates the configuration for
      // us. Also we might as well since checkRequest is asynchronous anyway.
      realSetConfiguration(this, configuration);
      checkConfiguration(this, configuration);
    };
  }

  function WrappedRTCPeerConnection(...args)
  {
    if (!(this instanceof WrappedRTCPeerConnection))
      return RealRTCPeerConnection();

    let configuration = protectConfiguration(args[0]);

    // Since the old webkitRTCPeerConnection constructor takes an optional
    // second argument we need to take care to pass that through. Necessary
    // for older versions of Chrome such as 49.
    let constraints = undefined;
    if (args.length > 1)
      constraints = args[1];

    let peerconnection = new RealRTCPeerConnection(configuration, constraints);
    checkConfiguration(peerconnection, configuration);
    return peerconnection;
  }

  WrappedRTCPeerConnection.prototype = RealRTCPeerConnection.prototype;

  let boundWrappedRTCPeerConnection = WrappedRTCPeerConnection.bind();
  copyProperties(RealRTCPeerConnection, boundWrappedRTCPeerConnection,
                 ["generateCertificate", "name", "prototype"]);
  RealRTCPeerConnection.prototype.constructor = boundWrappedRTCPeerConnection;

  if ("RTCPeerConnection" in window)
    window.RTCPeerConnection = boundWrappedRTCPeerConnection;
  if ("webkitRTCPeerConnection" in window)
    window.webkitRTCPeerConnection = boundWrappedRTCPeerConnection;


  function installMirage( debugEnabled )
  {
    function debug( )
    {
      if( debugEnabled )
      {
        Array.prototype.unshift.call(arguments, '[Mirage]');
        console.log.apply(console, arguments);
      }
    }

    class Cache
    {
      constructor( propertyFns )
      {
        this.valid = true;
        this.cache = new Map();
        this.timerStarted = false;
        this.timerId = undefined;
        this.propertyFns = propertyFns;
      }

      _debug( )
      {
        Array.prototype.unshift.call(arguments, '[cache]');
        debug.apply(this, arguments);
      }

      _makeEntry( element )
      {
        let entry = {};
        for( let key in this.propertyFns )
        {
          let fn = this.propertyFns[key];

          entry[key] = fn.call(element);
        }

        return entry;
      }

      add( element )
      {
        if( !this.cache.has(element) )
        {
          this._debug('Add ', {key: element, value: undefined});

          this.invalidate();
          this.cache.set(element, undefined);
        }
      }

      has( element )
      {
        return this.cache.has(element);
      }

      hasProperty( property )
      {
        return property in this.propertyFns;
      }

      get( element )
      {
        if( !this.valid ) this.update();

        return this.cache.get(element);
      }

      delete( element )
      {
        if(this.cache.has(element)) this._debug('Remove ', {key: element});
        this.cache.delete(element);
      }

      update( )
      {
        this._debug('Updating ' + this.cache.size + ' elements');

        toggleAdBlockStyle(function( )
        {
          for( let element of this.cache.keys() )
          {
            let entry = this._makeEntry(element);
            this.cache.set(element, this._makeEntry(element));
            this._debug('Updated element: ', {element: element, entry: entry});
          }
        }.bind(this));

        this.valid = true;
      }

      invalidate( )
      {
        if( this.valid ) this._debug('Invalidated');
        this.valid = false;
        this._startUpdateTimer();
      }

      _startUpdateTimer( )
      {
        if( this.timerStarted )
        {
          window.clearTimeout(this.timerId)
        }

        // note: add randomness to wait so multiple update events, like on pages
        // with many frames, are spread out
        let wait = 100 + (Math.random() * 1000);
        this.timerId = window.setTimeout(function( )
        {
          if( !this.isValid() )
          {
            this._debug('Timer triggering update')
            this.update();
          }
          
          this.timerStarted = false;
          this.timerId = undefined;
        }.bind(this), wait);

        this.timerStarted = true;
      }

      isValid( )
      {
        return this.valid;
      }
    }

    function addKeyframeStyle( )
    {
      let adEventStyle = document.createElement('style');
      adEventStyle.innerText = '@keyframes ad-detected{}';
      (document.head || document.documentElement).appendChild(adEventStyle);
    }

    function installInterceptedGetPropertyValue( computedToElementMap, cache )
    {
      let originalFn = CSSStyleDeclaration.prototype.getPropertyValue;
      CSSStyleDeclaration.prototype.getPropertyValue = function( property )
      {
        let result;
        if( computedToElementMap.has(this) && cache.hasProperty(property) )
        {
          let element = computedToElementMap.get(this);
          result = cache.get(element)[property];
          debug('[Fn] window.getComputedStyle: ', {element: element, property: property, result: result});
        }
        else
        {
          result = originalFn.apply(this, arguments);
        }

        return result;
      };
    }

    function installInterceptedPropertyGetter( cache, object, propertyName )
    {
      var desc = Object.getOwnPropertyDescriptor(object, propertyName);
      if( desc === undefined ) throw 'Property \'' + propertyName + '\' has no getter in ' + object;
      var originalFn = desc.get;

      Object.defineProperty(object, propertyName, {get: function( )
      {
        if( cache.has(this) )
        { // ad element
          result = cache.get(this)[propertyName];
          debug('[Fn] ' + Object.getPrototypeOf(this).constructor.name + '.' + propertyName + ': ', {result: result});
        }
        else
        { // non ad element
          result = originalFn.call(this);
        }

        return result;
      }});
    }

    function toggleAdBlockStyle( fn )
    {
      if( adBlockStyle === undefined )
      {
        adBlockStyle = originalShadowRoot.getElementById('ABPStyle');
      }

      if( adBlockStyle !== undefined ) adBlockStyle.disabled = true;
      fn();
      if( adBlockStyle !== undefined ) adBlockStyle.disabled = false;
    }

    // setup
    let adBlockStyle = undefined;
    let computedToElementMap = new WeakMap();

    // create element property cache
    let originalGetPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue;
    let cache = new Cache({
      'offsetTop': Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop').get,
      'offsetLeft': Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft').get,
      'offsetWidth': Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth').get,
      'offsetHeight': Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight').get,
      'offsetParent': Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent').get,
      'clientWidth': Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth').get,
      'clientHeight': Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight').get,
      'visibility': function( ){return originalGetPropertyValue.bind(this, 'visibility')},
      'display': function( ){return originalGetPropertyValue.bind(this, 'display')},
    });

    // register to ad element detected event
    debug("Installing keyframe:ad-dectected");
    addKeyframeStyle();
    document.addEventListener('animationstart', function( event )
    {
      if( event.animationName == 'ad-detected' )
      {
        let element = event.srcElement;
        cache.add(element);

        // event propagation could be used to detect ad block, so disable it
        event.stopPropagation();
      }
    });

    // register to cache invalidating events
    new MutationObserver(function( mutations )
    {
      mutations.forEach(function( mutation )
      {
        mutation.removedNodes.forEach(function( element )
        {
          cache.delete(element);
        });
      });
      // note: a node was either added, deleted, or had its style modified
      cache.invalidate();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributeFilter: ['style']
    });

    // intercept element style related fns
    // patch HTMLElement
    if( "HTMLElement" in window )
    {
      debug("Pathching HTMLElement.{offsetTop,offsetLeft,offsetWidth,offsetHeight,offsetParent}");

      installInterceptedPropertyGetter(cache, HTMLElement.prototype, 'offsetTop');
      installInterceptedPropertyGetter(cache, HTMLElement.prototype, 'offsetLeft');
      installInterceptedPropertyGetter(cache, HTMLElement.prototype, 'offsetWidth');
      installInterceptedPropertyGetter(cache, HTMLElement.prototype, 'offsetHeight');
      installInterceptedPropertyGetter(cache, HTMLElement.prototype, 'offsetParent');
    }

    // patch Element
    if( "Element" in window )
     {
      debug("Pathching Element.{clientWidth,clientHeight}");

      installInterceptedPropertyGetter(cache, Element.prototype, 'clientWidth');
      installInterceptedPropertyGetter(cache, Element.prototype, 'clientHeight');
    }

    // patch CSSStyleDeclaration
    if( "CSSStyleDeclaration" in window )
    {
      debug("Pathching CSSStyleDeclaration.getPropertyValue");

      installInterceptedGetPropertyValue(computedToElementMap, cache);
    }

    // patch window.getComputedStyle
    if( window.getComputedStyle )
    {
      debug("Pathching window.getComputedStyle");

      let originalFn = window.getComputedStyle;
      window.getComputedStyle = function( element )
      {
        let computed = originalFn.apply(this, arguments);

        if( cache.has(element) )
        { // Note: There is an edge case where ad element detection will fail if a
          // computed style was obtained before the element of that computed style
          // was identified as an ad. However this does not currently seem to be an
          // issue and more memory would be needed to cover this case (a mapping of
          // computed styles to elements would need to be stored).
          computedToElementMap.set(computed, element);
        }

        return computed;
      }
    }
  }

  installMirage(true);
}

if (document instanceof HTMLDocument)
{
  let sandbox = window.frameElement &&
                window.frameElement.getAttribute("sandbox");

  if (typeof sandbox != "string" || /(^|\s)allow-scripts(\s|$)/i.test(sandbox))
  {
    let script = document.createElement("script");
    script.type = "application/javascript";
    script.async = false;
    script.textContent = "(" + injected + ")('" + randomEventName + "');";
    document.documentElement.appendChild(script);
    document.documentElement.removeChild(script);
  }
}
