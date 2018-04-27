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
  'clients.insert': function (args) {
    var isnum = /^\d+$/.test(args.ci);
    var isvalid = args.qr != "No asignado";
    console.log(args);
    check(isnum, true);
    check(isvalid, true);
    Clients.insert(args);
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
Meteor.startup(() => {
  Meteor.publish('clients', function () {
    return Clients.find({});
  });
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
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvaW1wb3J0cy9jb2xsZWN0aW9ucy9jbGllbnRzLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9zZXJ2ZXIvbWFpbi5qcyJdLCJuYW1lcyI6WyJtb2R1bGUiLCJleHBvcnQiLCJDbGllbnRzIiwiTW9uZ28iLCJ3YXRjaCIsInJlcXVpcmUiLCJ2IiwiTWF0Y2giLCJjaGVjayIsIk1ldGVvciIsIm1ldGhvZHMiLCJhcmdzIiwiaXNudW0iLCJ0ZXN0IiwiY2kiLCJpc3ZhbGlkIiwicXIiLCJjb25zb2xlIiwibG9nIiwiaW5zZXJ0IiwiQ29sbGVjdGlvbiIsInN0YXJ0dXAiLCJwdWJsaXNoIiwiZmluZCJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7QUFBQUEsT0FBT0MsTUFBUCxDQUFjO0FBQUNDLFdBQVEsTUFBSUE7QUFBYixDQUFkO0FBQXFDLElBQUlDLEtBQUo7QUFBVUgsT0FBT0ksS0FBUCxDQUFhQyxRQUFRLGNBQVIsQ0FBYixFQUFxQztBQUFDRixRQUFNRyxDQUFOLEVBQVE7QUFBQ0gsWUFBTUcsQ0FBTjtBQUFROztBQUFsQixDQUFyQyxFQUF5RCxDQUF6RDtBQUE0RCxJQUFJQyxLQUFKLEVBQVVDLEtBQVY7QUFBZ0JSLE9BQU9JLEtBQVAsQ0FBYUMsUUFBUSxjQUFSLENBQWIsRUFBcUM7QUFBQ0UsUUFBTUQsQ0FBTixFQUFRO0FBQUNDLFlBQU1ELENBQU47QUFBUSxHQUFsQjs7QUFBbUJFLFFBQU1GLENBQU4sRUFBUTtBQUFDRSxZQUFNRixDQUFOO0FBQVE7O0FBQXBDLENBQXJDLEVBQTJFLENBQTNFO0FBRzNIRyxPQUFPQyxPQUFQLENBQWU7QUFFZCxvQkFBa0IsVUFBU0MsSUFBVCxFQUFlO0FBRWhDLFFBQUlDLFFBQVEsUUFBUUMsSUFBUixDQUFhRixLQUFLRyxFQUFsQixDQUFaO0FBQ0EsUUFBSUMsVUFBV0osS0FBS0ssRUFBTCxJQUFXLGFBQTFCO0FBRUFDLFlBQVFDLEdBQVIsQ0FBWVAsSUFBWjtBQUVBSCxVQUFNSSxLQUFOLEVBQVksSUFBWjtBQUNBSixVQUFNTyxPQUFOLEVBQWMsSUFBZDtBQUdBYixZQUFRaUIsTUFBUixDQUFlUixJQUFmO0FBRUE7QUFmYSxDQUFmO0FBbUJPLE1BQU1ULFVBQVUsSUFBSUMsTUFBTWlCLFVBQVYsQ0FBcUIsU0FBckIsQ0FBaEIsQzs7Ozs7Ozs7Ozs7QUN0QlAsSUFBSVgsTUFBSjtBQUFXVCxPQUFPSSxLQUFQLENBQWFDLFFBQVEsZUFBUixDQUFiLEVBQXNDO0FBQUNJLFNBQU9ILENBQVAsRUFBUztBQUFDRyxhQUFPSCxDQUFQO0FBQVM7O0FBQXBCLENBQXRDLEVBQTRELENBQTVEO0FBQStELElBQUlKLE9BQUo7QUFBWUYsT0FBT0ksS0FBUCxDQUFhQyxRQUFRLGdDQUFSLENBQWIsRUFBdUQ7QUFBQ0gsVUFBUUksQ0FBUixFQUFVO0FBQUNKLGNBQVFJLENBQVI7QUFBVTs7QUFBdEIsQ0FBdkQsRUFBK0UsQ0FBL0U7QUFHdEZHLE9BQU9ZLE9BQVAsQ0FBZSxNQUFNO0FBRXBCWixTQUFPYSxPQUFQLENBQWUsU0FBZixFQUEwQixZQUFXO0FBQ3BDLFdBQU9wQixRQUFRcUIsSUFBUixDQUFhLEVBQWIsQ0FBUDtBQUNBLEdBRkQ7QUFJQSxDQU5ELEUiLCJmaWxlIjoiL2FwcC5qcyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IE1vbmdvIH0gZnJvbSAnbWV0ZW9yL21vbmdvJztcbmltcG9ydCB7IE1hdGNoLCBjaGVjayB9IGZyb20gJ21ldGVvci9jaGVjayc7XG5cbk1ldGVvci5tZXRob2RzKHtcblxuXHQnY2xpZW50cy5pbnNlcnQnOiBmdW5jdGlvbihhcmdzKSB7XG5cblx0XHR2YXIgaXNudW0gPSAvXlxcZCskLy50ZXN0KGFyZ3MuY2kpO1xuXHRcdHZhciBpc3ZhbGlkID0gKGFyZ3MucXIgIT0gXCJObyBhc2lnbmFkb1wiKTtcblxuXHRcdGNvbnNvbGUubG9nKGFyZ3MpO1xuXG5cdFx0Y2hlY2soaXNudW0sdHJ1ZSk7XG5cdFx0Y2hlY2soaXN2YWxpZCx0cnVlKTtcblxuXG5cdFx0Q2xpZW50cy5pbnNlcnQoYXJncyk7XG5cblx0fVxuXG59KTtcblxuZXhwb3J0IGNvbnN0IENsaWVudHMgPSBuZXcgTW9uZ28uQ29sbGVjdGlvbignY2xpZW50cycpOyIsImltcG9ydCB7IE1ldGVvciB9IGZyb20gJ21ldGVvci9tZXRlb3InO1xuaW1wb3J0IHsgQ2xpZW50cyB9IGZyb20gJy4uL2ltcG9ydHMvY29sbGVjdGlvbnMvY2xpZW50cyc7XG5cbk1ldGVvci5zdGFydHVwKCgpID0+IHtcbiAgXG5cdE1ldGVvci5wdWJsaXNoKCdjbGllbnRzJywgZnVuY3Rpb24oKSB7XG5cdFx0cmV0dXJuIENsaWVudHMuZmluZCh7fSk7XG5cdH0pO1xuXG59KTtcbiJdfQ==
