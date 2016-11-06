'use strict';

const rateBeerBaseUrl = 'http://www.ratebeer.com/';
const scrapingDefaultErrorMessage = "This could be indicative that RateBeer has changed their layout and that this library needs an update. Please leave an issue on github!";

var path = require('path');
var cheerio = require('cheerio');
var request = require('request');

// Create base reques for fetching data
var pendingRequests = [];
var baseRequest = request.defaults({
  pool: {
    maxSockets: 15
  }
});

function parseUserRatings($, cb) {
  var ratingAttributes = $.find('div[style^="padding: 0px"]');
  var ratingReviews = $.find('div[style^="padding: 20px"]');
  var ratingAuthors = $.find('small[style^="color: #666666; font-size: 12px"]');

  // Check consistency
  if (ratingAttributes.length !== ratingReviews.length && ratingReviews.length !== ratingAuthors.length) {
    return cb(new Error('Ratings parsing failed. ' + scrapingDefaultErrorMessage));
  }

  // Collect data
  var ratings = [];
  for (var i = 0, c = ratingAttributes.length; i < c; i++) {
    var rating = {
      author: {},
      scores: {}
    };

    // Avatar section
    var ratingAttribute = cheerio(ratingAttributes[i]);
    var ratingAvatar = ratingAttribute.find('div');
    rating.author.avatarUri = ratingAvatar.find('img').attr('src');
    rating.scores.calculated = parseInt(ratingAvatar.last().text());

    // Rating details section
    var ratingDetails = ratingAttribute.find('strong > big');
    rating.scores.aroma = parseInt(ratingDetails[0].children[0].data);
    rating.scores.appearance = parseInt(ratingDetails[1].children[0].data);
    rating.scores.taste = parseInt(ratingDetails[2].children[0].data);
    rating.scores.palate = parseInt(ratingDetails[3].children[0].data);
    rating.scores.overall = parseInt(ratingDetails[4].children[0].data);

    // Rating author
    var ratingAuthor = ratingAuthors[i];
    var ratingAuthorDetails = ratingAuthor.children[0].children[0].data.match(/(\w+)/g);
    rating.author.profileUri = rateBeerBaseUrl + ratingAuthor.children[0].attribs.href.substring(1);
    rating.author.name = ratingAuthorDetails[0];
    rating.author.ratings = parseInt(ratingAuthorDetails[1]);

    // Rating location and date
    if (ratingAuthor.children[1].data) {
      var ratingCreationDetails = ratingAuthor.children[1].data.split('- ');
      rating.location = ratingCreationDetails[1].trim();
      rating.createdAt = ratingCreationDetails[2].trim();
    }

    // Rating content
    // Some reviews may be without content, so yeah...
    if (ratingReviews[i].children.length) {
      if (rating.author.name === 'jookos') {
        console.log(ratingReviews[i].children);
      }

      rating.content = ratingReviews[i].children.map(function (child) {
        return child.data;
      }).filter(function (data) {
        return data;
      }).join('\n');
    }

    ratings.push(rating);
  }

  cb(null, ratings);
}

function extractUserRatings($, url) {
  return new Promise(function(resolve, reject) {
    if ($) {
      parseUserRatings($, function(err, data) {
        if (err) return reject(err);
        resolve(data);
      });
    } else {
      var req = baseRequest({
        url: 'http://www.ratebeer.com' + url,
        encoding: 'binary'
      }, function(err, response, html) {
        if (err) return reject(err);
        var $ = cheerio.load(html);
        parseUserRatings($('table[style="padding: 10px;"]'), function(err, data) {
          if (err) return reject(err);
          resolve(data);
        });
      });

      pendingRequests.push(req);
    }
  });
}

var rb = module.exports = {
  searchAll: function(q, cb) {
    q = q
      .replace(/(\s)/g, '+')
      .replace(/'/g, '')
      .replace(/’/g, '')
      .replace(/"/g, '');

    q = escape(q);

    baseRequest.post({
      url: 'http://www.ratebeer.com/findbeer.asp',
      headers: { 'Content-Type':'application/x-www-form-urlencoded' },
      body: 'beername=' + q,
      encoding: 'binary'
    }, function(err, response, html) {
      if (err) return cb(err);
      var $ = cheerio.load(html);
      var result = $('table').first().find('td:first-child a').map(function() {
        var beer = $(this);
        return {
          name: beer.text().trim(),
          url: beer.attr('href')
        };
      });
      result = [].slice.apply(result);
      cb(null, result);
    });
  },
  search: function(q, cb) {
    rb.searchAll(q, function(e, result) {
      if (e) return cb(e);
      if (!result || result.length == 0) return cb();
      cb(null, result[0]);
    });
  },
  getBeer: function(q, opts, cb) {
    if (typeof cb === 'undefined') {
      cb = opts;
      opts = {};
    }

    rb.search(q, function(e, beer) {
      if (e) return cb(e);
      else if (beer == null) return cb();
      else rb.getBeerByUrl(beer.url, opts, cb);
    });
  },
  getBeerByUrl: function(url, opts, cb) {
    if (typeof cb === 'undefined') {
      cb = opts;
      opts = {};
    }

    baseRequest({
      url: 'http://www.ratebeer.com' + url,
      encoding: 'binary'
    }, function(err, response, html) {
      if (err) {
        return cb(err);
      }

      var $ = cheerio.load(html);
      var id = null;

      // Parse id from the url
      try {
        id = parseInt(url.split('/')[3]);
      } catch (e) {
      }

      // Handle aliased beer
      var aliasContent = $('div:contains("Proceed to the aliased beer...") a[href^="/beer/"]');
      if (aliasContent.length) {
        var aliasUrl = aliasContent.first().attr('href');
        if (aliasUrl) {
          opts.refId = id; // Retain original refId
          return rb.getBeerByUrl(aliasUrl, opts, cb);
        }
      }

      // Parse basic beer information
      var beerInfo = {
        id: opts.refId || id,
        refId: opts.refId ? id : null,
        url: url,
        name: $('[itemprop=name]').first().text(),
        ratingsCount: parseInt($('[itemprop=ratingCount]').text()),
        ratingsMeanAverage: parseFloat($('[name="real average"] big strong').text()),
        ratingsWeightedAverage: parseFloat($('[itemprop=ratingValue]').last().text())
      };

      // Parse overall and style rating
      var overallRatingContainer = $('div[class="score-container"] > div[class="ratingValue"]');
      var styleRatingContainer = $('div[class="style-text"]').parent().contents();

      beerInfo.ratingOverall = parseInt(overallRatingContainer.text()) || null;
      beerInfo.ratingStyle = styleRatingContainer.length && styleRatingContainer[0].type === 'text' ? parseInt(styleRatingContainer[0].data) : null;

      var titlePlate = $('big').first();

      if (!titlePlate.text().match(/brewed (by|at)/i)) {
        return cb(new Error("Page consistency check failed. " + scrapingDefaultErrorMessage));
      }

      titlePlate = titlePlate.parent();
      beerInfo.brewery = titlePlate.find('big b a').text();

      var brewedAt = titlePlate.find('big > a').text();
      if (brewedAt) {
        beerInfo.brewedAt = brewedAt;
      }

      beerInfo.style = titlePlate.children('a').first().text();

      try {
        beerInfo.location = titlePlate.find('br:last-child')[0].nextSibling.data.trim();
      } catch(e) {
      }

      var ibus = $('[title~=Bittering]').next('big').text();
      if (ibus) {
        beerInfo.ibu = parseInt(ibus);
      }

      var abv = $('[title~=Alcohol]').next('big').text();
      if (abv) {
        beerInfo.abv = parseFloat(abv);
      }

      var kcal = $('[title~=Estimated]').next('big').text();
      if (kcal) {
        beerInfo.kcal = parseFloat(kcal) || null;
      }

      var desc = $('[itemprop=reviewCount]').parents('div').first().next().text();
      if (desc) {
        beerInfo.desc = desc.replace(/^COMMERCIAL DESCRIPTION/, '');
      }

      var img = $('#beerImg').parent().attr('href');
      if (!img.match(/post\.asp/)) {
        beerInfo.image = img;
      }

      // Include user rating
      if (opts && opts.includeUserRatings) {
        var totalPages = $('a[class=ballno]').last().text();
        var startPage = 1;
        var ratingsSortingFlag = 1;

        // Switch sorting
        if (opts.sortByLatest) {
          ratingsSortingFlag = 1;
        } else if (opts.sortByTopRater) {
          ratingsSortingFlag = 2;
        } else if (opts.sortByHighest) {
          ratingsSortingFlag = 3;
        }

        // Generate requests
        // Don't send double requests for the first page if default sorting order is used
        var reqs = [];
        if (ratingsSortingFlag === 1) {
          reqs.push(extractUserRatings($('table[style="padding: 10px;"]'), null));
          startPage++;
        }

        for (var currentPage = startPage; currentPage <= totalPages; currentPage++) {
          reqs.push(extractUserRatings(null, path.resolve(url, ratingsSortingFlag.toString(), currentPage.toString()) + '/'));
        }

        Promise.all(reqs).then(function(pages) {
          beerInfo.ratings = {
            totalCount: pages.map(function(page) {
              return page.length;
            }).reduce(function(a, b) {
              return a + b;
            }),
            pagesCount: pages.length,
            pages: pages
          };

          cb(null, beerInfo);
        }, function(err) {
          pendingRequests.forEach(function(req) {
            req.abort();
          });
          cb(err);
        });
      } else {
        cb(null, beerInfo);
      }
    })
  }
};
