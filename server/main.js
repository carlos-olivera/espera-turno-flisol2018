import { Meteor } from 'meteor/meteor';
import { Clients } from '../imports/collections/clients';

Meteor.startup(() => {
  
	Meteor.publish('clients', function() {
		return Clients.find({});
	});

});
