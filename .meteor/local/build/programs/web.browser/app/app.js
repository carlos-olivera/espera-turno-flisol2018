var require = meteorInstall({"client":{"template.main.js":function(){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                             //
// client/template.main.js                                                                                     //
//                                                                                                             //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                               //

Template.body.addContent((function() {
  var view = this;
  return HTML.Raw('<div class="render-target"></div>');
}));
Meteor.startup(Template.body.renderToDocument);

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"components":{"clients_list.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                             //
// client/components/clients_list.js                                                                           //
//                                                                                                             //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                               //
var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");

var _inheritsLoose2 = _interopRequireDefault(require("@babel/runtime/helpers/inheritsLoose"));

var React, Component;
module.watch(require("react"), {
  "default": function (v) {
    React = v;
  },
  Component: function (v) {
    Component = v;
  }
}, 0);
var createContainer;
module.watch(require("meteor/react-meteor-data"), {
  createContainer: function (v) {
    createContainer = v;
  }
}, 1);
var Clients;
module.watch(require("../../imports/collections/clients"), {
  Clients: function (v) {
    Clients = v;
  }
}, 2);

var ClientsList =
/*#__PURE__*/
function (_Component) {
  (0, _inheritsLoose2.default)(ClientsList, _Component);

  function ClientsList() {
    return _Component.apply(this, arguments) || this;
  }

  var _proto = ClientsList.prototype;

  _proto.renderRows = function () {
    function renderRows() {
      return this.props.clients.map(function (client) {
        var ci = client.ci,
            qr = client.qr,
            atendido = client.atendido;
        return React.createElement("tr", {
          key: qr
        }, React.createElement("td", null, ci), React.createElement("td", null, qr), React.createElement("td", null, atendido.toString()));
      });
    }

    return renderRows;
  }();

  _proto.render = function () {
    function render() {
      return React.createElement("table", {
        className: "table"
      }, React.createElement("thead", null, React.createElement("tr", null, React.createElement("th", null, "CI"), React.createElement("th", null, "Ficha"), React.createElement("th", null, "Atendido"))), React.createElement("tbody", null, this.renderRows()));
    }

    return render;
  }();

  return ClientsList;
}(Component);

module.exportDefault(createContainer(function () {
  Meteor.subscribe('clients');
  return {
    clients: Clients.find({}).fetch()
  };
}, ClientsList));
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"header.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                             //
// client/components/header.js                                                                                 //
//                                                                                                             //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
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
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"new_client.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                             //
// client/components/new_client.js                                                                             //
//                                                                                                             //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
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
      result: 'No asignado',
      pendingRegister: true
    };
    _this.handleScan = _this.handleScan.bind((0, _assertThisInitialized2.default)(_this));
    _this.handleEnviarCI = _this.handleEnviarCI.bind((0, _assertThisInitialized2.default)(_this));
    return _this;
  }

  var _proto = NewClient.prototype;

  _proto.handleScan = function () {
    function handleScan(data) {
      if (data) {
        this.beep();
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

  _proto.beep = function () {
    function beep() {
      var snd = new Audio("data:audio/wav;base64,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qJrx4KOQjahZxWbcZgztj2c49nKmkId44S71j0c8eV9yDK6uPRzx5X18eDvjvQ6yKo9ZSS6l//8elePK/Lf//IInrOF/FvDoADYAGBMGb7FtErm5MXMlmPAJQVgWta7Zx2go+8xJ0UiCb8LHHdftWyLJE0QIAIsI+UbXu67dZMjmgDGCGl1H+vpF4NSDckSIkk7Vd+sxEhBQMRU8j/12UIRhzSaUdQ+rQU5kGeFxm+hb1oh6pWWmv3uvmReDl0UnvtapVaIzo1jZbf/pD6ElLqSX+rUmOQNpJFa/r+sa4e/pBlAABoAAAAA3CUgShLdGIxsY7AUABPRrgCABdDuQ5GC7DqPQCgbbJUAoRSUj+NIEig0YfyWUho1VBBBA//uQZB4ABZx5zfMakeAAAAmwAAAAF5F3P0w9GtAAACfAAAAAwLhMDmAYWMgVEG1U0FIGCBgXBXAtfMH10000EEEEEECUBYln03TTTdNBDZopopYvrTTdNa325mImNg3TTPV9q3pmY0xoO6bv3r00y+IDGid/9aaaZTGMuj9mpu9Mpio1dXrr5HERTZSmqU36A3CumzN/9Robv/Xx4v9ijkSRSNLQhAWumap82WRSBUqXStV/YcS+XVLnSS+WLDroqArFkMEsAS+eWmrUzrO0oEmE40RlMZ5+ODIkAyKAGUwZ3mVKmcamcJnMW26MRPgUw6j+LkhyHGVGYjSUUKNpuJUQoOIAyDvEyG8S5yfK6dhZc0Tx1KI/gviKL6qvvFs1+bWtaz58uUNnryq6kt5RzOCkPWlVqVX2a/EEBUdU1KrXLf40GoiiFXK///qpoiDXrOgqDR38JB0bw7SoL+ZB9o1RCkQjQ2CBYZKd/+VJxZRRZlqSkKiws0WFxUyCwsKiMy7hUVFhIaCrNQsKkTIsLivwKKigsj8XYlwt/WKi2N4d//uQRCSAAjURNIHpMZBGYiaQPSYyAAABLAAAAAAAACWAAAAApUF/Mg+0aohSIRobBAsMlO//Kk4soosy1JSFRYWaLC4qZBYWFRGZdwqKiwkNBVmoWFSJkWFxX4FFRQWR+LsS4W/rFRb/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////VEFHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAU291bmRib3kuZGUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMjAwNGh0dHA6Ly93d3cuc291bmRib3kuZGUAAAAAAAAAACU=");
      snd.play();
    }

    return beep;
  }();

  _proto.handleEnviarCI = function () {
    function handleEnviarCI(event) {
      var _this2 = this;

      event.preventDefault();
      console.log(this.refs.inputCI.value);
      Meteor.call('clients.insert', {
        'ci': this.refs.inputCI.value,
        'qr': this.refs.inputQR.value,
        'atendido': false
      }, function (error) {
        if (error) {
          _this2.setState({
            error: 'Error en el ingreso de datos'
          });
        } else {
          _this2.setState({
            error: ''
          });

          _this2.refs.inputCI.value = '';
          _this2.refs.inputQR.value = 'No asignado';

          _this2.setState({
            pendingRegister: false
          });
        }

        ;
      });
      console.log(this.state.pendingRegister);
    }

    return handleEnviarCI;
  }();

  _proto.renderForm = function () {
    function renderForm() {
      return React.createElement("form", {
        onSubmit: this.handleEnviarCI.bind(this)
      }, React.createElement("div", {
        className: "from-group"
      }, React.createElement("label", null, "Ingrese el N\xFAmero de CI"), React.createElement("input", {
        ref: "inputCI",
        className: "form-control"
      }), React.createElement("br", null)), React.createElement("div", null, React.createElement(QrReader, {
        delay: this.state.delay,
        onError: this.handleError,
        onScan: this.handleScan,
        style: {
          width: '100%'
        }
      }), React.createElement("input", {
        ref: "inputQR",
        className: "form-control",
        readOnly: "true",
        value: this.state.result
      })), React.createElement("div", {
        className: "text-danger"
      }, this.state.error), React.createElement("button", {
        className: "btn btn-primary"
      }, "Nuevo cliente"));
    }

    return renderForm;
  }();

  _proto.render = function () {
    function render() {
      return React.createElement("div", null, this.state.pendingRegister ? this.renderForm() : null);
    }

    return render;
  }();

  return NewClient;
}(Component);

;
module.exportDefault(NewClient);
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}},"main.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                             //
// client/main.js                                                                                              //
//                                                                                                             //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
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
var ClientList;
module.watch(require("./components/clients_list"), {
  "default": function (v) {
    ClientList = v;
  }
}, 6);

var App = function () {
  return React.createElement("div", null, React.createElement(Header, null), React.createElement(NewClient, null), React.createElement(ClientList, null));
};

Meteor.startup(function () {
  ReactDOM.render(React.createElement(App, null), document.querySelector('.render-target'));
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}},"imports":{"collections":{"clients.js":function(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                             //
// imports/collections/clients.js                                                                              //
//                                                                                                             //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
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
  'clients.insert': function (args) {
    var isnum = /^\d+$/.test(args.ci);
    var isvalid = args.qr != "No asignado";
    console.log(args);
    check(isnum, true);
    check(isvalid, true);
    Clients.insert(args);
  }
});
var Clients = new Mongo.Collection('clients');
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}}}},{
  "extensions": [
    ".js",
    ".json",
    ".html"
  ]
});
require("/client/template.main.js");
require("/client/components/clients_list.js");
require("/client/components/header.js");
require("/client/components/new_client.js");
require("/client/main.js");