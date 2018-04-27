import React, { Component } from 'react';
import { createContainer } from 'meteor/react-meteor-data';
import { Clients } from '../../imports/collections/clients';

class ClientsList extends Component {

	renderRows() {

		return this.props.clients.map( client => {

			const {ci,qr,atendido} = client;
			return (
				<tr key={qr}>
				 <td>{ci}</td>
				 <td>{qr}</td>
				 <td>{atendido.toString()}</td>
				</tr>
				);
		});
	}


	render() {
		return (
			<table className="table">
				<thead>
					<tr>
						<th>CI</th>
						<th>Ficha</th>
						<th>Atendido</th>
					</tr>
				</thead>
				<tbody>
					{this.renderRows()}
				</tbody>
			</table>
		);
	}
}

export default createContainer( () => {
	
	Meteor.subscribe('clients');

	return { clients: Clients.find({}).fetch() };


}, ClientsList);