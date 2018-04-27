import { Mongo } from 'meteor/mongo';
import { Match, check } from 'meteor/check';

Meteor.methods({

	'clients.insert': function(newCI) {

		var isnum = /^\d+$/.test(newCI);
		check(isnum,true);


		Clients.insert({});

	}

});

export const Clients = new Mongo.Collection('clients');