import { Mongo } from 'meteor/mongo';
import { Match, check } from 'meteor/check';

Meteor.methods({

	'clients.insert': function(args) {

		var isnum = /^\d+$/.test(args.ci);
		var isvalid = (args.qr != "No asignado");

		console.log(args);

		check(isnum,true);
		check(isvalid,true);


		Clients.insert(args);

	}

});

export const Clients = new Mongo.Collection('clients');