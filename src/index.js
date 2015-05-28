var stripe = require('stripe');
var q = require('q');
var request = require('request');
/**
 * A bridge connecting le-bank-service to Stripe
 * @class BankProvider
 * @param {string} secretKey the stripe secret key for your account
 * @param {StorageService} storage an instance of le-storage-service that is used to create records
 * @returns {service}
 */
var BankProvider = function (secretKey, storage) {
  if (!secretKey) { throw new Error('Secret key required'); }
  if (!storage) { throw new Error('Storage service required'); }
  var _provider = this;
  var _api = stripe(secretKey);
  /**
   * Creates a bank account
   *
   * Requires two tokens, one for crediting the bank account
   * and one for debiting the bank account. Simply generate
   * two tokens with the same bank account credentials.
   * @function createBankAccount
   * @memberof BankProvider
   * @instance
   * @param {string} countryCode the two letter country code of the bank's origin
   * @param {string} creditToken the tokenized bank account info
   * @param {string} debitToken the tokenized bank account info
   * @returns {promise} resolves with the newly created bankAccount record
   */
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
  /**
   * Creates a credit card
   * @function createCreditCard
   * @memberof BankProvider
   * @instance
   * @param {string} token the tokenized credit card info
   * @returns {promise} resolves with the newly created creditCard record
   */
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
  /**
   * Verifies that the user has access to the bank account using micro-deposits
   *
   * @function verifyBankAccount
   * @memberof BankService
   * @instance
   * @param {record} bankAccount the record of the bank account to be verified
   * @param {array} amounts the micro-deposit verification amounts
   * @returns {promise}
   */
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
  /**
   * Charges a stripe customer
   * @function chargeCustomer
   * @memberof BankProvider
   * @instance
   * @param {string} customer the id of the stripe customer to charge
   * @param {number} cents the numbers of cents to charge
   * @param {string} account (optional) the id of the stripe account to credit
   * @returns {promise}
   */
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
  /**
   * Charges a bank account
   * @function chargeBankAccount
   * @memberof BankProvider
   * @instance
   * @param {record} bankAccount the record of the bank account to be charged
   * @param {number} cents the numbers of cents to charge
   * @returns {promise} resolves with the newly created payment record
   */
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
  /**
   * Charges a credit card
   * @function chargeCreditCard
   * @memberof BankProvider
   * @instance
   * @param {record} card the record of the credit card to be charged
   * @param {number} cents the numbers of cents to charge
   * @returns {promise} resolves with the newly created payment record
   */
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
  /**
   * Transfers money from a funding source to a bank account
   * @function transfer
   * @memberof BankProvider
   * @instance
   * @param {record} source the record of the credit card or bank account to be charged
   * @param {record} destination the record of the bank account to be credited
   * @param {number} cents the number of cents to transfer
   * @returns {promise} resolves with the newly created payment record
   */
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
  /**
   * Returns a bank account record, given the id
   * @function getBankAccount
   * @memberof BankProvider
   * @instance
   * @param {string} id the id of the bank account record
   * @returns {record}
   */
  this.getBankAccount = function (id) {
    return storage.createRecord('Bank Account', id);
  }
  /**
   * Returns a credit card record, given the id
   * @function getCreditCard
   * @memberof BankProvider
   * @instance
   * @param {string} id the id of the credit card record
   * @returns {record}
   */
  this.getCreditCard = function (id) {
    return storage.createRecord('Credit Card', id);
  }
};

module.exports = BankProvider;
