var fs = require('fs');
var path = require('path');
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
var BankProvider = function(secretKey, storage) {
  if (!secretKey) {
    throw new Error('Secret key required');
  }
  if (!storage) {
    throw new Error('Storage service required');
  }
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
   * @param {string} email the email to assocaite with the stripe customer
   * @returns {promise} resolves with the newly created bankAccount record
   */
  this.createBankAccount = function(countryCode, creditToken, debitToken, email) {
    var bankAccount;
    var promises = [];
    var accountData = {};
    accountData.managed = true;
    accountData.country = countryCode;
    accountData.bank_account = creditToken;
    if (email) {
      accountData.email = email;
    }
    promises.push(_api.accounts.create(accountData));
    var customerData = {};
    customerData.bank_account = debitToken;
    if (email) {
      customerData.email = email;
    }
    promises.push(_api.customers.create(customerData));
    return q.all(promises)
      .spread(function(account, customer) {
        bankAccount = storage.createRecord('Bank Account');
        return bankAccount.update({
          _stripe: {
            customer_id: customer.id,
            account_id: account.id,
            bankAccount_id: customer.default_source
          }
        });
      })
      .then(function() {
        return bankAccount
      });
  };
  /**
   * Creates a credit card
   * @function createCreditCard
   * @memberof BankProvider
   * @instance
   * @param {string} token the tokenized credit card info
   * @param {string} email the email to assocaite with the stripe customer
   * @returns {promise} resolves with the newly created creditCard record
   */
  this.createCreditCard = function(token, email) {
    var customerData = {};
    customerData.card = token;
    if (email) {
      customerData.email = email;
    }
    return _api.customers.create(customerData)
      .then(function(customer) {
        var creditCard = storage.createRecord('Credit Card');
        return creditCard.update({
            _stripe: {
              customer_id: customer.id,
              creditCard_id: customer.default_source
            }
          })
          .then(function() {
            return creditCard;
          });
      });
  };
  /**
   * Verifies that the user has access to the bank account using micro-deposits
   *
   * @function verifyBankAccount
   * @memberof BankProvider
   * @instance
   * @param {record} bankAccount the record of the bank account to be verified
   * @param {array} amounts the micro-deposit verification amounts
   * @returns {promise}
   */
  this.verifyBankAccount = function(bankAccount, amounts) {
    return bankAccount.load()
      .then(function(data) {
        var customer = data._stripe.customer_id;
        var id = data._stripe.bankAccount_id;
        var deferred = q.defer();
        // node client doesn't support verifying bank accounts, so we must make the HTTP request ourselves :/
        var url = 'https://api.stripe.com/v1/customers/' + customer + '/bank_accounts/' + id + '/verify';
        var options = {
          url: url,
          auth: {
            'bearer': secretKey
          },
          form: {
            amounts: amounts
          },
          qsStringifyOptions: {
            arrayFormat: 'brackets'
          }
        };
        request.post(options, function(err, resp) {
          if (!err && resp.statusCode == 200) {
            data.verifiedAt = new Date();
            bankAccount.update(data)
              .then(function() {
                deferred.resolve();
              })
          } else {
            errMessage = JSON.parse(resp.body).error.message;
            deferred.reject(errMessage);
          }
        });
        return deferred.promise;
      });
  };
  /**
   * Verifies that the user is who they say they are
   *
   * Basic verification requires the following properties on the identity object:
   * - legal_entity.first_name
   * - legal_entity.last_name
   * - legal_entity.dob.day
   * - legal_entity.dob.month
   * - legal_entity.dob.year
   * - legal_entity.type
   * - tos_acceptance.ip
   * - tos_acceptance.date
   * @function verifyIdentity
   * @memberof BankProvider
   * @instance
   * @param {record} bankAccount the record of the bank account to be verified
   * @param {Object} identity the map of identity fields
   * @param {string} filepath (optional) path to uploaded image of government ID
   * @returns {promise}
   */
  this.verifyIdentity = function(bankAccount, identity, filepath) {
    var account;
    return bankAccount.load()
      .then(function(data) {
        account = data._stripe.account_id;
        var promise = _api.accounts.update(account, identity);
        if (filepath) {
          var filename = path.basename(filepath);
          promise.then(function() {
            return _api.fileUploads.create({
              purpose: 'identity_document',
              file: {
                data: fs.readFileSync(filepath),
                name: filename,
                type: 'application/octet-stream'
              }
            }, {
              stripe_account: account
            });
          })
            .then(function(file) {
              var fileID = file.id;
              return _api.accounts.update(account, {
                legal_entity: {
                  verification: {
                    document: fileID
                  }
                }
              });
            });
        }
        return promise;
      })
  };
  /**
   * Checks that the verification process was successful
   * @function isIdentityVerified
   * @memberof BankProvider
   * @instance
   * @param {record} bankAccount the record of the bank account to be verified
   * @returns {promise}
   */
  this.isIdentityVerified = function(bankAccount) {
    var account;
    return bankAccount.load()
      .then(function(data) {
        account = data._stripe.account_id;
        return _api.accounts.retrieve(account);
      })
      .then(function(data) {
        if (data &&
          data.legal_entity &&
          data.legal_entity.verification &&
          data.legal_entity.verification.status) {
          var verification = data.legal_entity.verification;
          var status = verification.status;
          if (status === 'verified') {
            return;
          } else if (status === 'pending') {
            return q.reject(new Error('Identity verification pending'));
          } else if (status === 'unverified') {
            if (verification.details) {
              return q.reject(new Error(verification.details));
            } else {
              return q.reject(new Error('Identity unverified, reason unknown'));
            }
          }
        } else {
          return q.reject(new Error('Identity verification status missing from Stripe account'));
        }
      });
  };
  /**
   * Charges a stripe customer
   * @function chargeCustomer
   * @memberof BankProvider
   * @instance
   * @param {string} customer the id of the stripe customer to charge
   * @param {number} cents the numbers of cents to charge
   * @param {string} accountID (optional) the id of the stripe account to credit, bankAccountID required if set
   * @param {string} description intended for end users to read, such as in a bank statement
   * @returns {promise}
   */
  this.chargeCustomer = function (customer, cents, accountID, description) {
    if (!description) {
      description = 'Castle';
    }
    var promise;
    if (accountID) {
      var charge;
      promise = _api.charges.create({
        amount: cents,
        currency: 'usd',
        customer: customer,
        destination: accountID,
        description: description
      }).then(function(returnedCharge){
        charge = returnedCharge;
        return _api.transfers.create({
          amount: cents,
          currency: 'usd',
          destination: 'default_for_currency',
          description: description,
          source_transaction: charge.id
        }, {
          stripe_account: accountID
        });
      }).then(function(){
        return charge;
      });
    } else {
      promise = _api.charges.create({
        amount: cents,
        currency: 'usd',
        customer: customer,
        description: description
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
  this.chargeBankAccount = function(bankAccount, cents) {
    var customer;
    var payment;
    return bankAccount.load()
      .then(function(data) {
        if (data.verifiedAt) {
          customer = data._stripe.customer_id;
          return _provider.chargeCustomer(customer, cents);
        } else {
          return q.reject(new Error('Bank accounts must be verified before they can be charged'));
        }
      })
      .then(function(charge) {
        payment = storage.createRecord('Payment');
        return payment.update({
          cents: cents,
          _stripe: {
            customer_id: customer,
            charge_id: charge.id
          }
        });
      })
      .then(function() {
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
  this.chargeCreditCard = function(card, cents) {
    var customer;
    var payment;
    return card.load()
      .then(function(data) {
        customer = data._stripe.customer_id;
        return _provider.chargeCustomer(customer, cents);
      })
      .then(function(charge) {
        payment = storage.createRecord('Payment');
        return payment.update({
          cents: cents,
          _stripe: {
            customer_id: customer,
            charge_id: charge.id
          }
        });
      })
      .then(function() {
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
   * @param {string} description intended for end users to read, such as in a bank statement
   * @returns {promise} resolves with the newly created payment record
   */
  this.transfer = function(source, destination, cents, description) {
    var customer;
    var accountID;
    var payment;
    return source.load()
      .then(function(data) {
        customer = data._stripe.customer_id;
        return destination.load();
      })
      .then(function(data) {
        accountID = data._stripe.account_id;
        return _provider.chargeCustomer(customer, cents, accountID, description);
      })
      .then(function(charge) {
        payment = storage.createRecord('Payment');
        return payment.update({
          cents: cents,
          _stripe: {
            customer_id: customer,
            account_id: accountID,
            charge_id: charge.id
          }
        });
      })
      .then(function() {
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
  this.getBankAccount = function(id) {
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
  this.getCreditCard = function(id) {
    return storage.createRecord('Credit Card', id);
  }
};

module.exports = BankProvider;
