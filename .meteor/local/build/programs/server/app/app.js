var require = meteorInstall({"imports":{"collections":{"clients.js":function(require,exports,module){

///////////////////////////////////////////////////////////////////////
//                                                                   //
// imports/collections/clients.js                                    //
//                                                                   //
///////////////////////////////////////////////////////////////////////
                                                                     //
module.export({
  Clients: () => Clients
});
let Mongo;
module.watch(require("meteor/mongo"), {
  Mongo(v) {
    Mongo = v;
  }

}, 0);
let Match, check;
module.watch(require("meteor/check"), {
  Match(v) {
    Match = v;
  },

  check(v) {
    check = v;
  }

}, 1);
Meteor.methods({
  'clients.insert': function (newCI) {
    var isnum = /^\d+$/.test(newCI);
    check(isnum, true);
    Clients.insert({});
  }
});
const Clients = new Mongo.Collection('clients');
///////////////////////////////////////////////////////////////////////

}}},"server":{"main.js":function(require,exports,module){

///////////////////////////////////////////////////////////////////////
//                                                                   //
// server/main.js                                                    //
//                                                                   //
///////////////////////////////////////////////////////////////////////
                                                                     //
let Meteor;
module.watch(require("meteor/meteor"), {
  Meteor(v) {
    Meteor = v;
  }

}, 0);
let Clients;
module.watch(require("../imports/collections/clients"), {
  Clients(v) {
    Clients = v;
  }

}, 1);
Meteor.startup(() => {// code to run on server at startup
});
///////////////////////////////////////////////////////////////////////

}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});
require("/server/main.js");
//# sourceURL=meteor://💻app/app/app.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvaW1wb3J0cy9jb2xsZWN0aW9ucy9jbGllbnRzLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9zZXJ2ZXIvbWFpbi5qcyJdLCJuYW1lcyI6WyJtb2R1bGUiLCJleHBvcnQiLCJDbGllbnRzIiwiTW9uZ28iLCJ3YXRjaCIsInJlcXVpcmUiLCJ2IiwiTWF0Y2giLCJjaGVjayIsIk1ldGVvciIsIm1ldGhvZHMiLCJuZXdDSSIsImlzbnVtIiwidGVzdCIsImluc2VydCIsIkNvbGxlY3Rpb24iLCJzdGFydHVwIl0sIm1hcHBpbmdzIjoiOzs7Ozs7OztBQUFBQSxPQUFPQyxNQUFQLENBQWM7QUFBQ0MsV0FBUSxNQUFJQTtBQUFiLENBQWQ7QUFBcUMsSUFBSUMsS0FBSjtBQUFVSCxPQUFPSSxLQUFQLENBQWFDLFFBQVEsY0FBUixDQUFiLEVBQXFDO0FBQUNGLFFBQU1HLENBQU4sRUFBUTtBQUFDSCxZQUFNRyxDQUFOO0FBQVE7O0FBQWxCLENBQXJDLEVBQXlELENBQXpEO0FBQTRELElBQUlDLEtBQUosRUFBVUMsS0FBVjtBQUFnQlIsT0FBT0ksS0FBUCxDQUFhQyxRQUFRLGNBQVIsQ0FBYixFQUFxQztBQUFDRSxRQUFNRCxDQUFOLEVBQVE7QUFBQ0MsWUFBTUQsQ0FBTjtBQUFRLEdBQWxCOztBQUFtQkUsUUFBTUYsQ0FBTixFQUFRO0FBQUNFLFlBQU1GLENBQU47QUFBUTs7QUFBcEMsQ0FBckMsRUFBMkUsQ0FBM0U7QUFHM0hHLE9BQU9DLE9BQVAsQ0FBZTtBQUVkLG9CQUFrQixVQUFTQyxLQUFULEVBQWdCO0FBRWpDLFFBQUlDLFFBQVEsUUFBUUMsSUFBUixDQUFhRixLQUFiLENBQVo7QUFDQUgsVUFBTUksS0FBTixFQUFZLElBQVo7QUFHQVYsWUFBUVksTUFBUixDQUFlLEVBQWY7QUFFQTtBQVZhLENBQWY7QUFjTyxNQUFNWixVQUFVLElBQUlDLE1BQU1ZLFVBQVYsQ0FBcUIsU0FBckIsQ0FBaEIsQzs7Ozs7Ozs7Ozs7QUNqQlAsSUFBSU4sTUFBSjtBQUFXVCxPQUFPSSxLQUFQLENBQWFDLFFBQVEsZUFBUixDQUFiLEVBQXNDO0FBQUNJLFNBQU9ILENBQVAsRUFBUztBQUFDRyxhQUFPSCxDQUFQO0FBQVM7O0FBQXBCLENBQXRDLEVBQTRELENBQTVEO0FBQStELElBQUlKLE9BQUo7QUFBWUYsT0FBT0ksS0FBUCxDQUFhQyxRQUFRLGdDQUFSLENBQWIsRUFBdUQ7QUFBQ0gsVUFBUUksQ0FBUixFQUFVO0FBQUNKLGNBQVFJLENBQVI7QUFBVTs7QUFBdEIsQ0FBdkQsRUFBK0UsQ0FBL0U7QUFJdEZHLE9BQU9PLE9BQVAsQ0FBZSxNQUFNLENBQ25CO0FBQ0QsQ0FGRCxFIiwiZmlsZSI6Ii9hcHAuanMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBNb25nbyB9IGZyb20gJ21ldGVvci9tb25nbyc7XG5pbXBvcnQgeyBNYXRjaCwgY2hlY2sgfSBmcm9tICdtZXRlb3IvY2hlY2snO1xuXG5NZXRlb3IubWV0aG9kcyh7XG5cblx0J2NsaWVudHMuaW5zZXJ0JzogZnVuY3Rpb24obmV3Q0kpIHtcblxuXHRcdHZhciBpc251bSA9IC9eXFxkKyQvLnRlc3QobmV3Q0kpO1xuXHRcdGNoZWNrKGlzbnVtLHRydWUpO1xuXG5cblx0XHRDbGllbnRzLmluc2VydCh7fSk7XG5cblx0fVxuXG59KTtcblxuZXhwb3J0IGNvbnN0IENsaWVudHMgPSBuZXcgTW9uZ28uQ29sbGVjdGlvbignY2xpZW50cycpOyIsImltcG9ydCB7IE1ldGVvciB9IGZyb20gJ21ldGVvci9tZXRlb3InO1xuXG5pbXBvcnQgeyBDbGllbnRzIH0gZnJvbSAnLi4vaW1wb3J0cy9jb2xsZWN0aW9ucy9jbGllbnRzJztcblxuTWV0ZW9yLnN0YXJ0dXAoKCkgPT4ge1xuICAvLyBjb2RlIHRvIHJ1biBvbiBzZXJ2ZXIgYXQgc3RhcnR1cFxufSk7XG4iXX0=
