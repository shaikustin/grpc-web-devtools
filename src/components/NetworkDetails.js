// Copyright (c) 2019 SafetyCulture Pty Ltd. All Rights Reserved.

import React, { Component } from 'react';
import ReactJson from 'react-json-view';
import { connect } from 'react-redux';
import './NetworkDetails.css';

class NetworkDetails extends Component {
  render() {
    const { entry } = this.props;
    return (
      <div className="widget vbox details-data">
        {this._renderContent(entry)}
      </div>
    );
  }
  _renderContent = (entry) => {
    if (entry) {
      const { clipboardIsEnabled } = this.props;
      const { method, request, response, responseHeaders, error } = entry;
      const theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'twilight' : 'rjv-default';
      var src = { method };
      if (request) src.request = request;
      if (response) src.response = response;
      if (responseHeaders) src.responseHeaders = responseHeaders;
      if (error) src.error = error;
      
      
      // Check if x-trace-id is available (case-insensitive)
      let traceId = null;
      if (responseHeaders) {
        // Try common variants first
        traceId = responseHeaders['x-trace-id'] || 
                  responseHeaders['X-Trace-Id'] || 
                  responseHeaders['X-TRACE-ID'];
        
        // If not found, search case-insensitively
        if (!traceId) {
          const traceIdKey = Object.keys(responseHeaders).find(key => key.toLowerCase() === 'x-trace-id');
          if (traceIdKey) {
            traceId = responseHeaders[traceIdKey];
          }
        }
      }
      
      // Check for executionId in request or response
      let executionId = null;
      if (request && request.executionId) {
        executionId = request.executionId;
      }
      // Check response for executionId (response takes precedence)
      if (response && response.executionId) {
        executionId = response.executionId;
      }
      
      
      return (
        <div>
          {(traceId || executionId) && (
            <div className="trace-id-container">
              {traceId && (
                <button 
                  className="trace-id-button" 
                  onClick={() => this._openTraceLink(traceId)}
                  title="Open trace"
                  style={{ marginRight: '8px' }}
                >
                  View Trace: {traceId}
                </button>
              )}
              {executionId && (
                <button 
                  className="trace-id-button" 
                  onClick={() => this._openRuntimeTools(executionId)}
                  title="Open in runtime tools"
                >
                  Open in Runtime Tools
                </button>
              )}
            </div>
          )}
          <ReactJson
            name="grpc"
            theme={theme}
            style={{backgroundColor:'transparent'}}
            enableClipboard={clipboardIsEnabled}
            src={src}
          />
        </div>
      )
    }
  }
  
  _openTraceLink = (traceId) => {
    const { entry } = this.props;
    
    // Determine project ID based on the hostname from the gRPC message
    let currentHost = '';
    if (entry && entry.hostname) {
      currentHost = entry.hostname;
    } else if (entry && entry.url) {
      try {
        const url = new URL(entry.url);
        currentHost = url.hostname;
      } catch (e) {
        currentHost = window.location.hostname;
      }
    } else {
      // Fallback to window.location if no hostname in entry
      currentHost = window.location.hostname;
    }
    
    let projectID = 'stackpulse-production'; // default
    
    if (currentHost.endsWith('stg.torq.io')) {
      projectID = 'stackpulse-staging';
    } else if (currentHost.endsWith('eu.torq.io')) {
      projectID = 'torqio-eu-production';
    }
    
    // Calculate time range (1 hour back from now)
    const now = new Date();
    const startTime = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago
    const endTime = now;
    
    // Check for executionId in request or response
    let executionId = null;
    if (entry) {
      // Check request for executionId
      if (entry.request && entry.request.executionId) {
        executionId = entry.request.executionId;
      }
      // Check response for executionId (response takes precedence)
      if (entry.response && entry.response.executionId) {
        executionId = entry.response.executionId;
      }
    }
    
    // Build attributes array for execution-id only (trace-id goes in path)
    const attributes = [];
    
    // Add execution-id if found
    if (executionId) {
      attributes.push({
        key: 'execution-id',
        value: [executionId]
      });
    }
    
    // Build the query structure for GCP Trace Explorer
    const query = {
      plotType: 'HEATMAP',
      pointConnectionMethod: 'GAP_DETECTION',
      targetAxis: 'Y1',
      traceQuery: {
        resourceContainer: `projects/${projectID}/locations/global`,
        spanDataValue: 'SPAN_DURATION',
        spanFilters: {
          attributes: attributes,
          displayNames: [],
          isRootSpan: false,
          kinds: [],
          maxDuration: '',
          minDuration: '',
          services: [],
          status: []
        }
      }
    };
    
    // Create the URL with traceId in path
    const queryJSON = JSON.stringify(query);
    const baseURL = `https://console.cloud.google.com/traces/explorer;query=${encodeURIComponent(queryJSON)};traceId=${traceId};startTime=${startTime.toISOString()};endTime=${endTime.toISOString()}`;
    
    // Add query parameters
    const params = new URLSearchParams({
      project: projectID,
      query: queryJSON,
      inv: '1'
    });
    
    const url = `${baseURL}?${params.toString()}`;
    window.open(url, '_blank');
  }
  
  _openRuntimeTools = (executionId) => {
    const url = `https://runtime-tools.torqio.dev/executions?execution_id=${executionId}`;
    window.open(url, '_blank');
  }
}

const mapStateToProps = state => ({ entry: state.network.selectedEntry, clipboardIsEnabled: state.clipboard.clipboardIsEnabled });
export default connect(mapStateToProps)(NetworkDetails);
