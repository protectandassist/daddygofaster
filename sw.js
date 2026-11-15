/* TorchHive notifications. A push from the browser's push service carries no
   words: this asks the bid service what to show, shows it, and opens the site
   when it is tapped. It keeps no copy of any page, so the site always loads fresh. */
var API = (function(){
  var a = new URL(self.location).searchParams.get('api') || '';
  return /^(https:\/\/dgf-bids\.trevor-c2b\.workers\.dev|http:\/\/127\.0\.0\.1:\d+)$/.test(a) ? a : 'https://dgf-bids.trevor-c2b.workers.dev';
})();
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function(e){
  e.waitUntil(
    self.registration.pushManager.getSubscription().then(function(sub){
      if(!sub) return null;
      return fetch(API + '/push/next', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({endpoint: sub.endpoint})})
        .then(function(r){ return r.ok ? r.json() : null; });
    }).catch(function(){ return null; }).then(function(m){
      return self.registration.showNotification((m && m.title) || 'TorchHive', {
        body: (m && m.body) || 'There is news on your bid.',
        icon: '/assets/icon-192.png', badge: '/assets/favicon.png', tag: 'torchhive', renotify: true
      });
    })
  );
});
self.addEventListener('notificationclick', function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(function(list){
    for(var i = 0; i < list.length; i++){ if('focus' in list[i]) return list[i].focus(); }
    return self.clients.openWindow('/#board');
  }));
});
