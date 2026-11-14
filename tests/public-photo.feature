Feature: Audience-marked public wiki photo page

  Scenario: A mobile reader opens the public photo page away from home
    Given the public photo page is served over HTTPS from static edge files
    When an iPhone 13 mobile viewport opens it over a cellular-like network
    Then the page declares audience public
    And the public-domain photo and its attribution load
    And the largest contentful paint is no more than 2.5 seconds
