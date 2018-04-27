import React, { Component } from 'react';
import ReactDOM from 'react-dom';
import { Match } from 'meteor/check';
import QrReader from 'react-qr-reader'


class NewClient extends Component {


	constructor(props) {

		super(props);
		this.state = { 
			error: '',
			delay: 300,
      		result: 'No result'
		};

		this.handleScan = this.handleScan.bind(this)
	};

	handleScan(data){

    if(data){
      this.setState({
        result: data,
      })
    }
    }
  
    handleError(err){
    		console.error(err)
    }


	handleEnviarCI(event) {
		event.preventDefault();

		console.log(this.refs.inputCI.value);

		Meteor.call('clients.insert', this.refs.inputCI.value, (error) => {

			if (error) {
				this.setState({ error: 'Ingrese un CI válido' });

			} else {
				this.setState({ error: ''});



				this.refs.inputCI.value = '';


			};

			console.log(error);
		});
	}

	render() {

		return (

			<form onSubmit={this.handleEnviarCI.bind(this)}>
				<div className="from-group">
					<label>Ingrese el Número de CI</label>
					<input ref="inputCI" className="form-control"/>
				</div>
				<div>
				        <QrReader
				          delay={this.state.delay}
				          onError={this.handleError}
				          onScan={this.handleScan}
				          style={{ width: '100%' }}
				          />
				        <input ref="inputCI" className="form-control" value={this.state.result}/>
				        <p>{this.state.result}</p>
				</div>
				<div className="text-danger">{this.state.error}</div>
				<button className="btn btn-primary">Nuevo cliente</button>
			</form>

		);

	};
};

export default NewClient;