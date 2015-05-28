var q = require('q');
var BankProvider = require('../../src/index.js');
var chai = require('chai');
var sinon = require('sinon');
var sinonChai = require('sinon-chai');
var chaiAsPromised = require("chai-as-promised");
var expect = chai.expect;
chai.use(sinonChai);
chai.use(chaiAsPromised);

describe('BankProvider', function () {
  var secret = 'ABC123';
  var mockStorage = {
    createRecord: function () {
      return {
        update: function () { return q.resolve(); },
        getID: function () { return 1; },
        load: function () { return q.resolve({token:'derp'}); }
      }
    }
  };
  it('should respect logic', function () {
    expect(true).to.be.true;
    expect(true).not.to.be.false;
  });
  it('should require a secret key and provider', function () {
    expect(function () { new BankProvider(); }).to.throw();
    expect(function () { new BankProvider(secret); }).to.throw();
    expect(function () { new BankProvider(secret, mockStorage); }).not.to.throw();
  });
});
