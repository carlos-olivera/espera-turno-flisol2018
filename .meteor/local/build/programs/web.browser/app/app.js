var require = meteorInstall({"client":{"template.main.js":function(){

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                  //
// client/template.main.js                                                                                          //
//                                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                    //

Template.body.addContent((function() {
  var view = this;
  return HTML.Raw('<div class="render-target"></div>');
}));
Meteor.startup(Template.body.renderToDocument);

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"components":{"header.js":function(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                  //
// client/components/header.js                                                                                      //
//                                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                    //
var React;
module.watch(require("react"), {
  "default": function (v) {
    React = v;
  }
}, 0);
var ReactDOM;
module.watch(require("react-dom"), {
  "default": function (v) {
    ReactDOM = v;
  }
}, 1);

var Header = function () {
  return React.createElement("nav", {
    className: "nav navbar-default"
  }, React.createElement("div", {
    className: "navbar-header"
  }, React.createElement("a", {
    className: "navbar-brand"
  }, "Mi turno")));
};

module.exportDefault(Header);
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"new_client.js":function(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                  //
// client/components/new_client.js                                                                                  //
//                                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                    //
var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

var _inheritsLoose2 = _interopRequireDefault(require("@babel/runtime/helpers/inheritsLoose"));

var _assertThisInitialized2 = _interopRequireDefault(require("@babel/runtime/helpers/assertThisInitialized"));

var React, Component;
module.watch(require("react"), {
  "default": function (v) {
    React = v;
  },
  Component: function (v) {
    Component = v;
  }
}, 0);
var ReactDOM;
module.watch(require("react-dom"), {
  "default": function (v) {
    ReactDOM = v;
  }
}, 1);
var Match;
module.watch(require("meteor/check"), {
  Match: function (v) {
    Match = v;
  }
}, 2);
var QrReader;
module.watch(require("react-qr-reader"), {
  "default": function (v) {
    QrReader = v;
  }
}, 3);

var NewClient =
/*#__PURE__*/
function (_Component) {
  (0, _inheritsLoose2.default)(NewClient, _Component);

  function NewClient(props) {
    var _this;

    _this = _Component.call(this, props) || this;
    _this.state = {
      error: '',
      delay: 300,
      result: 'No result'
    };
    _this.handleScan = _this.handleScan.bind((0, _assertThisInitialized2.default)(_this));
    return _this;
  }

  var _proto = NewClient.prototype;

  _proto.handleScan = function () {
    function handleScan(data) {
      if (data) {
        this.setState({
          result: data
        });
      }
    }

    return handleScan;
  }();

  _proto.handleError = function () {
    function handleError(err) {
      console.error(err);
    }

    return handleError;
  }();

  _proto.handleEnviarCI = function () {
    function handleEnviarCI(event) {
      var _this2 = this;

      event.preventDefault();
      console.log(this.refs.inputCI.value);
      Meteor.call('clients.insert', this.refs.inputCI.value, function (error) {
        if (error) {
          _this2.setState({
            error: 'Ingrese un CI válido'
          });
        } else {
          _this2.setState({
            error: ''
          });

          _this2.refs.inputCI.value = '';
        }

        ;
        console.log(error);
      });
    }

    return handleEnviarCI;
  }();

  _proto.render = function () {
    function render() {
      return React.createElement("form", {
        onSubmit: this.handleEnviarCI.bind(this)
      }, React.createElement("div", {
        className: "from-group"
      }, React.createElement("label", null, "Ingrese el N\xFAmero de CI"), React.createElement("input", {
        ref: "inputCI",
        className: "form-control"
      })), React.createElement("div", null, React.createElement(QrReader, {
        delay: this.state.delay,
        onError: this.handleError,
        onScan: this.handleScan,
        style: {
          width: '100%'
        }
      }), React.createElement("input", {
        ref: "inputCI",
        className: "form-control",
        value: this.state.result
      }), React.createElement("p", null, this.state.result)), React.createElement("div", {
        className: "text-danger"
      }, this.state.error), React.createElement("button", {
        className: "btn btn-primary"
      }, "Nuevo cliente"));
    }

    return render;
  }();

  return NewClient;
}(Component);

;
module.exportDefault(NewClient);
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}},"main.js":function(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                  //
// client/main.js                                                                                                   //
//                                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                    //
var React;
module.watch(require("react"), {
  "default": function (v) {
    React = v;
  }
}, 0);
var ReactDOM;
module.watch(require("react-dom"), {
  "default": function (v) {
    ReactDOM = v;
  }
}, 1);
var Meteor;
module.watch(require("meteor/meteor"), {
  Meteor: function (v) {
    Meteor = v;
  }
}, 2);
var Header;
module.watch(require("./components/header"), {
  "default": function (v) {
    Header = v;
  }
}, 3);
var NewClient;
module.watch(require("./components/new_client"), {
  "default": function (v) {
    NewClient = v;
  }
}, 4);
var Clients;
module.watch(require("../imports/collections/clients"), {
  Clients: function (v) {
    Clients = v;
  }
}, 5);

var App = function () {
  return React.createElement("div", null, React.createElement(Header, null), React.createElement(NewClient, null));
};

Meteor.startup(function () {
  ReactDOM.render(React.createElement(App, null), document.querySelector('.render-target'));
});
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}},"imports":{"collections":{"clients.js":function(require,exports,module){

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                  //
// imports/collections/clients.js                                                                                   //
//                                                                                                                  //
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                    //
module.export({
  Clients: function () {
    return Clients;
  }
});
var Mongo;
module.watch(require("meteor/mongo"), {
  Mongo: function (v) {
    Mongo = v;
  }
}, 0);
var Match, check;
module.watch(require("meteor/check"), {
  Match: function (v) {
    Match = v;
  },
  check: function (v) {
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
var Clients = new Mongo.Collection('clients');
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}}}},{
  "extensions": [
    ".js",
    ".json",
    ".html"
  ]
});
require("/client/template.main.js");
require("/client/components/header.js");
require("/client/components/new_client.js");
require("/client/main.js");