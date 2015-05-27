var stripe = require('stripe');
var q = require('q');
var request = require('request');

var BankProviderStripe = function (secretKey, storage) {
  if (!secretKey) { throw new Error('Secret key required'); }
  if (!storage) { throw new Error('Storage service required'); }
  var _provider = this;
  var _api = stripe(secretKey);

  this.createBankAccount = function (countryCode, creditToken, debitToken) {
    var bankAccount;
    var promises = [];
    promises.push(_api.accounts.create({
      managed: true,
      country: countryCode,
      bank_account: creditToken
    }));
    promises.push(_api.customers.create({
      bank_account: debitToken
    }));
    return q.all(promises)
    .spread(function (account, customer) {
      bankAccount = storage.createRecord('Bank Account');
      return bankAccount.update({
        _stripe: {
          customer_id: customer.id,
          account_id: account.id,
          bankAccount_id: customer.default_source
        }
      });
    })
    .then(function () { return bankAccount });
  };

  this.createCreditCard = function (token) {
    return _api.customers.create({
      card: token
    })
    .then(function (customer) {
      var creditCard = storage.createRecord('Credit Card');
      return creditCard.update({
        _stripe: {
          customer_id: customer.id,
          creditCard_id: customer.default_source
        }
      })
      .then(function () {
        return creditCard;
      });
    });
  };

  this.getBankAccount = function (id) {
    return storage.createRecord('Bank Account', id);
  }

  this.getCreditCard = function (id) {
    return storage.createRecord('Credit Card', id);
  }

  this.chargeCustomer = function (customer, cents, account) {
    var promise;
    if (account) {
      promise = _api.charges.create({
        amount: cents,
        currency: 'usd',
        customer: customer,
        destination: account,
        description: 'Castle'
      });
    } else {
      promise = _api.charges.create({
        amount: cents,
        currency: 'usd',
        customer: customer,
        description: 'Castle'
      });
    }
    return promise;
  };

  this.chargeCreditCard = function (card, cents) {
    var customer;
    var payment;
    return card.load()
    .then(function (data) {
      customer = data._stripe.customer_id;
      return _provider.chargeCustomer(customer, cents);
    })
    .then(function (charge) {
      payment = storage.createRecord('Payment');
      return payment.update({
        cents: cents,
        _stripe: { customer_id: customer, charge_id: charge.id }
      });
    })
    .then(function () {
      return payment;
    });
  };

  this.chargeBankAccount = function (bankAccount, cents) {
    var customer;
    var payment;
    return bankAccount.load()
    .then(function (data) {
      if (data.verifiedAt) {
        customer = data._stripe.customer_id;
        return _provider.chargeCustomer(customer, cents);
      } else { return q.reject('Bank accounts must be verified before they can be charged'); }
    })
    .then(function (charge) {
      payment = storage.createRecord('Payment');
      return payment.update({
        cents: cents,
        _stripe: { customer_id: customer, charge_id: charge.id }
      });
    })
    .then(function () {
      return payment;
    });
  };

  this.transfer = function (source, destination, cents) {
    var customer;
    var account;
    var payment;
    return source.load()
    .then(function (data) {
      customer = data._stripe.customer_id;
      return destination.load();
    })
    .then(function (data) {
      account = data._stripe.account_id;
      return _provider.chargeCustomer(customer, cents, account);
    })
    .then(function (charge) {
      payment = storage.createRecord('Payment');
      return payment.update({
        cents: cents,
        _stripe: { customer_id: customer, account_id: account, charge_id: charge.id }
      });
    })
    .then(function () {
      return payment;
    });
  };

  this.verifyBankAccount = function (bankAccount, amounts) {
    return bankAccount.load()
    .then(function (data) {
      var customer = data._stripe.customer_id;
      var id = data._stripe.bankAccount_id;
      var deferred = q.defer();
      // node client doesn't support verifying bank accounts, so we must make the HTTP request ourselves :/
      var url = 'https://api.stripe.com/v1/customers/' + customer + '/bank_accounts/' + id + '/verify';
      var options = {
        url: url,
        auth: { 'bearer': secretKey },
        form: { amounts: amounts },
        qsStringifyOptions: { arrayFormat: 'brackets' }
      };
      request.post(options, function (err, resp) {
        if (!err && resp.statusCode == 200) {
          data.verifiedAt = new Date();
          bankAccount.update(data)
          .then(function () { deferred.resolve(); })
        } else {
          errMessage = JSON.parse(resp.body).error.message;
          deferred.reject(errMessage);
        }
      });
      return deferred.promise;
    });
  };

};

module.exports = BankProviderStripe;
