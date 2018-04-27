import React from 'react';
import ReactDOM from 'react-dom';
import { Meteor } from 'meteor/meteor';

import Header from './components/header';
import NewClient from './components/new_client';

import { Clients } from '../imports/collections/clients';

const App = () => {

	return (
			<div>
				<Header />
				<NewClient />
			</div>
		);
};

Meteor.startup( () => {
	ReactDOM.render(<App />, document.querySelector('.render-target'));
});